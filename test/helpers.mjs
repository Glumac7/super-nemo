import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
export const MODELS = path.join(REPO, "test", "fixtures", "models.json");
const OMP_OWNED = /(^|\/)(agent\.db|models\.db)(-shm|-wal)?$|^\.omp\/(logs|natives)(\/|$)/;

export function sandbox(t, { agentDir: makeAgentDir = true } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-test-")));
  t.after(() => {
    spawnSync("chmod", ["-R", "u+w", home]);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const agentDir = path.join(home, ".omp", "agent");
  if (makeAgentDir) fs.mkdirSync(agentDir, { recursive: true });
  const env = { ...process.env, HOME: home, SN_MODELS_JSON: MODELS, GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_FILES", "XDG_CONFIG_HOME", "SN_REPO", "SN_REPO_URL", "SN_REF", ...GIT_LOCATION]) delete env[k];
  const snHome = path.join(home, ".super-nemo");
  const run = (cmd, args, extraEnv = {}, opts = {}) => {
    const res = spawnSync(cmd, args, { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 120_000, ...opts });
    return { code: res.status, out: res.stdout + res.stderr };
  };
  return {
    home,
    agentDir,
    snHome,
    env,
    manifestPath: path.join(snHome, "state", "manifest.json"),
    file: (name) => path.join(agentDir, name),
    read: (name) => fs.readFileSync(path.join(agentDir, name), "utf8"),
    write: (name, text) => fs.writeFileSync(path.join(agentDir, name), text),
    manifest: () => JSON.parse(fs.readFileSync(path.join(snHome, "state", "manifest.json"), "utf8")),
    sn: (args, extraEnv = {}) => run(path.join(REPO, "sn"), args, extraEnv),
    run,
    git: (cwd, args) => run("git", [...IDENTITY, ...args], {}, { cwd }),
    clone: path.join(snHome, "repo"),
    bootstrap: (args, extraEnv = {}) => detached("bash", ["-s", "--", ...args], { env: { ...env, ...extraEnv }, input: fs.readFileSync(path.join(REPO, "install.sh")) }),
  };
}

export const INSTALL = ["install", "--yes", "--no-smoke"];

export function detached(cmd, args, { env, input, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.end(input ?? "");
  });
}

const GIT_LOCATION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"];
const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

function gitSync(cwd, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const k of GIT_LOCATION) delete env[k];
  const res = spawnSync("git", [...IDENTITY, ...args], { cwd, env, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

let template;
function templateRemote() {
  if (template) return template;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-fixture-")));
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, "work");
  const files = gitSync(REPO, ["ls-files", "-z", "-co", "--exclude-standard"]).split("\0").filter(Boolean);
  for (const f of files) {
    const src = path.join(REPO, f);
    if (!fs.lstatSync(src, { throwIfNoEntry: false })?.isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.copyFileSync(src, path.join(work, f));
    fs.chmodSync(path.join(work, f), fs.statSync(src).mode & 0o777);
  }
  fs.cpSync(path.join(REPO, "node_modules"), path.join(work, "node_modules"), { recursive: true });
  gitSync(work, ["init", "-q", "-b", "main"]);
  gitSync(work, ["add", "-A"]);
  gitSync(work, ["add", "-f", "node_modules"]);
  gitSync(work, ["commit", "-qm", "fixture"]);
  template = path.join(root, "template.git");
  gitSync(root, ["clone", "-q", "--bare", work, template]);
  return template;
}

export function remote(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-remote-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, "super-nemo.git");
  fs.cpSync(templateRemote(), bare, { recursive: true });
  const url = `file://${bare}`;
  return {
    bare,
    url,
    commit(message, mutate) {
      const work = fs.mkdtempSync(path.join(root, "work-"));
      gitSync(root, ["clone", "-q", bare, work]);
      mutate(work);
      gitSync(work, ["add", "-A"]);
      gitSync(work, ["commit", "-qm", message]);
      gitSync(work, ["push", "-q", "origin", "main"]);
      const sha = gitSync(work, ["rev-parse", "HEAD"]);
      fs.rmSync(work, { recursive: true, force: true });
      return sha;
    },
  };
}

export function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (OMP_OWNED.test(rel)) continue;
      if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(abs)}`;
      else if (e.isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(abs);
      } else out[rel] = fs.readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}

export function seedUserContent(s) {
  s.write("config.yml", [
    "# my settings",
    "modelRoles:",
    "  default: beta/sol:medium # my everyday model",
    "  smol: alpha/small",
    "bash:",
    "  patterns:",
    "    - match: \"*rm -rf /*\"",
    "      approval: deny",
    "    - match: \"npm test*\"",
    "      approval: allow",
    "theme:",
    "  dark: midnight",
    "",
  ].join("\n"));
  s.write("AGENTS.md", "# My rules\n\nAlways answer in English.\n");
  s.write("WATCHDOG.md", "Watch for flaky tests.");
}
