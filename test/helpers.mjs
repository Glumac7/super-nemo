import { spawnSync } from "node:child_process";
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
  const env = { ...process.env, HOME: home, SN_MODELS_JSON: MODELS };
  for (const k of ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_FILES"]) delete env[k];
  const snHome = path.join(home, ".super-nemo");
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
    sn: (args, extraEnv = {}) => {
      const res = spawnSync(path.join(REPO, "sn"), args, { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 120_000 });
      return { code: res.status, out: res.stdout + res.stderr };
    },
  };
}

export const INSTALL = ["install", "--yes", "--no-smoke"];

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
