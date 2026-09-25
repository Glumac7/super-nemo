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

export const GITHUB_URL = "https://github.com/Glumac7/super-nemo.git";
export const ANONYMOUS = ["-c", "credential.helper=", "-c", "core.askPass="];
export const VIA_GH = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-c", "core.askPass="];
export const PRIVATE_HINT = "the repository may be private or unreachable";
export const GH_HINT = "for a private fork install `gh` and run `gh auth login`";

const sh = (text) => `'${text.replace(/'/g, "'\\''")}'`;
const executable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

export function githubStyle(t, s, target, { gh = "absent", protocols = "file", gitconfig = "" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-tools-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const logs = { git: path.join(root, "git.log"), gh: path.join(root, "gh.log"), credential: path.join(root, "credential.log"), askpass: path.join(root, "askpass.log") };
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const realGit = dirs.map((d) => path.join(d, "git")).find(executable);
  const pathDirs = dirs.map((dir, i) => {
    if (!executable(path.join(dir, "gh"))) return dir;
    const shadow = path.join(root, `path-${i}`);
    fs.mkdirSync(shadow);
    for (const name of fs.readdirSync(dir)) if (name !== "gh") fs.symlinkSync(path.join(dir, name), path.join(shadow, name));
    return shadow;
  });
  const logged = '"${GIT_TERMINAL_PROMPT-unset}" "${GIT_ASKPASS-unset}" "${SSH_ASKPASS-unset}"';
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash\n{ printf '%s\\x1f' ${logged} "$@"; printf '\\n'; } >> ${sh(logs.git)}\nexec ${sh(realGit)} "$@"\n`, { mode: 0o755 });
  if (gh !== "absent") {
    const status = gh === "logged-in" ? 0 : 1;
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${sh(logs.gh)}\nif [ "$1 $2" = "auth status" ]; then exit ${status}; fi\nexit 1\n`, { mode: 0o755 });
  }
  const marker = (name, log) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "$*" >> ${sh(log)}\nprintf 'leaked\\n'\n`, { mode: 0o755 });
    return file;
  };
  const helper = marker("credential-helper", logs.credential);
  const askpass = marker("askpass", logs.askpass);
  fs.writeFileSync(path.join(s.home, ".gitconfig"), `[url "${target}"]\n\tinsteadOf = ${GITHUB_URL}\n[credential]\n\thelper = ${helper}\n[core]\n\taskPass = ${askpass}\n${gitconfig}`);
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  return {
    env: { PATH: [bin, ...pathDirs].join(":"), GIT_ALLOW_PROTOCOL: protocols, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass },
    network: () => lines(logs.git).map((l) => {
      const [prompt, gitAskpass, sshAskpass, ...args] = l.split("\x1f").slice(0, -1);
      const cmd = args.findIndex((a, i) => (i === 0 || !["-c", "-C"].includes(args[i - 1])) && !["-c", "-C"].includes(a));
      return { prompt, gitAskpass, sshAskpass, config: args.slice(0, cmd), command: args[cmd] };
    }).filter((c) => ["clone", "fetch"].includes(c.command)),
    ghCalls: () => lines(logs.gh),
    credentialCalls: () => lines(logs.credential),
    askpassCalls: () => lines(logs.askpass),
  };
}

export function authServer(t) {
  const log = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-http-"))), "requests.log");
  const child = spawn(process.execPath, ["-e", [
    "const fs = require('fs');",
    "const srv = require('http').createServer((req, res) => {",
    "  fs.appendFileSync(process.argv[1], req.url + '\\n');",
    "  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"sn\"' });",
    "  res.end();",
    "}).listen(0, '127.0.0.1', () => console.log(srv.address().port));",
  ].join("\n"), log], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => {
    child.kill();
    fs.rmSync(path.dirname(log), { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (d) => resolve({
      url: `http://127.0.0.1:${String(d).trim()}/super-nemo.git`,
      requests: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    }));
  });
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

export const INTERNAL = /\b(modelRoles|task|tools|advisor|bash)\.[\w-]|@default|@nemo-/;
export const withoutKeyRefs = (out) => out.replace(/ \(config\.ya?ml: [\w.-]+\)/g, "");

export function underPty(command, env, answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-pty-"));
  const fifo = path.join(dir, "keys");
  spawnSync("mkfifo", [fifo]);
  const inner = `${command}; echo "SN-PTY-EXIT=$?"`;
  const pty = process.platform === "darwin" ? "script -q /dev/null bash -c \"$0\"" : "script -qec \"$0\" /dev/null";
  const child = spawn("bash", ["-c", `cat "$1" | ${pty} 2>&1 | cat`, inner, fifo], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const keys = fs.createWriteStream(fifo);
  let out = "";
  let cursor = 0;
  let code = null;
  const questions = [];
  const onData = (d) => {
    out += d;
    for (;;) {
      const m = /Choice \[\d+\]: |\[[yY]\/[nN](?:\/c(?:=change)?)?\] /.exec(out.slice(cursor));
      if (!m) break;
      const question = out.slice(cursor, cursor + m.index + m[0].length);
      cursor += m.index + m[0].length;
      questions.push(question);
      keys.write(`${answer(question)}\r`);
    }
    const exit = /SN-PTY-EXIT=(\d+)/.exec(out);
    if (exit && code === null) {
      code = Number(exit[1]);
      keys.end();
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return new Promise((resolve) => {
    const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 180_000);
    child.on("close", () => {
      clearTimeout(timer);
      keys.end();
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, out, questions });
    });
  });
}

