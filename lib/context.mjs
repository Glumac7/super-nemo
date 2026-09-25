import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { SnError, lstat, realish, symlinkedComponent } from "./util.mjs";

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const KINDS = ["config", "agents", "watchdogMd", "watchdogYml"];

function shippedNames(repo) {
  const skills = fs.readdirSync(path.join(repo, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(repo, "skills", e.name, "SKILL.md")))
    .map((e) => e.name);
  const agents = fs.readdirSync(path.join(repo, "agents"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name.slice(0, -3));
  for (const name of [...skills, ...agents]) {
    if (!NAME.test(name)) throw new SnError(`refusing to install unexpected name ${JSON.stringify(name)}`);
  }
  return { skills: skills.sort(), agents: agents.sort() };
}

function resolveAgentDir(home, profileFlag, env) {
  const raw = profileFlag ?? (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
  const profile = raw?.trim();
  if (profile && profile !== "default") {
    if (!PROFILE.test(profile)) throw new SnError(`invalid profile name ${JSON.stringify(raw)}`, 2);
    return path.join(home, ".omp", "profiles", profile, "agent");
  }
  if (env.PI_CODING_AGENT_DIR) {
    const dir = env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/)/, home);
    return path.resolve(dir);
  }
  return path.join(home, ".omp", "agent");
}

function configPath(agentDir) {
  const yml = path.join(agentDir, "config.yml");
  const yaml = path.join(agentDir, "config.yaml");
  if (lstat(yaml) && !lstat(yml)) return { path: yaml };
  if (lstat(yaml) && lstat(yml)) return { path: yml, problem: `both ${yml} and ${yaml} exist; remove one` };
  return { path: yml };
}

export function createContext({ profile } = {}) {
  const home = realish(os.homedir());
  const repo = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const env = { ...process.env };
  if (profile !== undefined) env.OMP_PROFILE = profile;
  const agentDir = realish(resolveAgentDir(home, profile, process.env));
  const snHome = realish(path.join(home, ".super-nemo"));
  const state = path.join(snHome, "state");
  const names = shippedNames(repo);
  const config = configPath(agentDir);
  const symlinks = [
    ...names.skills.map((n) => ({ path: path.join(agentDir, "skills", n), target: path.join(repo, "skills", n) })),
    ...names.agents.map((n) => ({ path: path.join(agentDir, "agents", `${n}.md`), target: path.join(repo, "agents", `${n}.md`) })),
    { path: path.join(snHome, "current"), target: repo },
  ];
  const agentAncestors = [];
  for (let d = agentDir; d !== home && d !== path.dirname(d) && d.startsWith(home + path.sep); d = path.dirname(d)) {
    agentAncestors.push(d);
  }
  if (!agentAncestors.includes(agentDir)) agentAncestors.unshift(agentDir);
  return {
    home,
    repo,
    env,
    agentDir,
    snHome,
    state,
    manifestPath: path.join(state, "manifest.json"),
    backupsDir: path.join(state, "backups"),
    cloneDir: path.join(snHome, "repo"),
    bootstrap: { clone: process.env.SN_BOOTSTRAP_CLONE === "1", createdHome: process.env.SN_BOOTSTRAP_CREATED_HOME === "1" },
    names,
    symlinks,
    files: {
      config: config.path,
      agents: path.join(agentDir, "AGENTS.md"),
      watchdogMd: path.join(agentDir, "WATCHDOG.md"),
      watchdogYml: path.join(agentDir, "WATCHDOG.yml"),
    },
    configProblem: config.problem,
    ourPath: (p) => [agentDir, snHome].some((root) => p.startsWith(root + path.sep) && symlinkedComponent(root, p) === null),
    allowedConfigPaths: [path.join(agentDir, "config.yml"), path.join(agentDir, "config.yaml")],
    allowedDirs: [path.join(agentDir, "skills"), path.join(agentDir, "agents"), ...agentAncestors],
  };
}

let neutralCwd;
function neutral() {
  if (!neutralCwd) {
    neutralCwd = fs.mkdtempSync(path.join(os.tmpdir(), "sn-omp-"));
    process.on("exit", () => fs.rmSync(neutralCwd, { recursive: true, force: true }));
  }
  return neutralCwd;
}

export function runOmp(ctx, args) {
  return new Promise((resolve) => {
    execFile("omp", args, { cwd: neutral(), env: ctx.env, encoding: "utf8", timeout: 120_000, maxBuffer: 64 << 20 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

export function watchdogEntry(ctx) {
  return YAML.parse(fs.readFileSync(path.join(ctx.repo, "watchdog", "WATCHDOG.yml"), "utf8")).advisors[0];
}

export const ourPatterns = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.repo, "config", "deny-patterns.json"), "utf8"));

export function desiredKeys(c) {
  const keys = {
    "modelRoles.default": c.impl,
    "modelRoles.nemo-review": c.review,
    "task.agentModelOverrides.reviewer": "@nemo-review",
    "task.agentModelOverrides.security-reviewer": "@nemo-review",
    "task.agentModelOverrides.task": "@default",
    "task.agentModelOverrides.scout": c.fast ? "@nemo-fast" : "@default",
    "task.agentModelOverrides.sonic": c.fast ? "@nemo-fast" : "@default",
    "task.isolation.enabled": true,
    "advisor.syncBacklog": "3",
    "tools.approvalMode": c.approval,
    "tools.approval.eval": "prompt",
  };
  if (c.fast) keys["modelRoles.nemo-fast"] = c.fast;
  if (c.advisor) {
    keys["modelRoles.advisor"] = c.advisor;
    keys["modelRoles.advisor-critical"] = c.advisorCritical;
  } else {
    keys["task.agentAdvisor.nemo-implementer"] = "off";
    keys["task.agentAdvisor.nemo-implementer-critical"] = "off";
  }
  return keys;
}

export const MANAGED_KEYS = Object.keys({ ...desiredKeys({ fast: "x", advisor: "x" }), ...desiredKeys({}) });
