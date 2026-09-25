#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXPECT = {
  light: { exactly: ["nemo-quality"], forbidPrefix: "nemo-implementer", changes: true },
  normal: {
    includes: ["nemo-implementer", "nemo-architect", "nemo-quality", "nemo-qa", "reviewer", "nemo-final-review"],
    changes: true,
  },
  critical: {
    includes: [
      "nemo-implementer-critical",
      "nemo-architect",
      "nemo-security",
      "nemo-quality",
      "nemo-qa",
      "reviewer",
      "nemo-final-review",
    ],
    changes: true,
  },
  auto: { includesPrefix: "nemo-", changes: true },
  implicit: { includesPrefix: "nemo-", changes: true },
  question: { exactly: [], changes: false },
};

function jsonlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsonlFiles(p);
    return e.isFile() && e.name.endsWith(".jsonl") ? [p] : [];
  });
}

function readEntries(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function mainSessionAgents(sessionsDir, repoDir) {
  const repoReal = fs.realpathSync(repoDir);
  const mains = [];
  for (const file of jsonlFiles(sessionsDir)) {
    const entries = readEntries(file);
    const header = entries.find((e) => e.type === "session");
    if (!header || header.parentSession || typeof header.cwd !== "string") continue;
    let cwd;
    try {
      cwd = fs.realpathSync(header.cwd);
    } catch {
      continue;
    }
    if (cwd === repoReal) mains.push(entries);
  }
  if (mains.length !== 1) throw new Error(`expected exactly one main session for ${repoDir}, found ${mains.length}`);
  const agents = [];
  for (const entry of mains[0]) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    for (const part of entry.message.content ?? []) {
      if (part?.type !== "toolCall" || part.name !== "task") continue;
      for (const task of part.arguments?.tasks ?? []) {
        if (typeof task?.agent === "string") agents.push(task.agent);
      }
    }
  }
  return agents;
}

function repoChanged(repoDir) {
  const git = (...args) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  const root = git("rev-list", "--max-parents=0", "HEAD").trim().split("\n")[0];
  const tracked = spawnSync("git", ["diff", "--quiet", root], { cwd: repoDir }).status !== 0;
  return tracked || git("ls-files", "--others", "--exclude-standard").trim() !== "";
}

function check(mode, agents, { changed, testsPass }) {
  const want = EXPECT[mode];
  if (!want) return [`unknown mode ${mode}`];
  const failures = [];
  if (want.exactly && JSON.stringify(agents) !== JSON.stringify(want.exactly)) {
    failures.push(`expected agents exactly [${want.exactly}], got [${agents}]`);
  }
  if (want.forbidPrefix && agents.some((a) => a.startsWith(want.forbidPrefix))) {
    failures.push(`no ${want.forbidPrefix}* agent expected, got [${agents}]`);
  }
  for (const name of want.includes ?? []) {
    if (!agents.includes(name)) failures.push(`missing agent ${name} in [${agents}]`);
  }
  if (want.includesPrefix && !agents.some((a) => a.startsWith(want.includesPrefix))) {
    failures.push(`expected a ${want.includesPrefix}* agent, got [${agents}]`);
  }
  if (want.changes && !changed) failures.push("expected a non-empty diff");
  if (!want.changes && changed) failures.push("expected no changes");
  if (want.changes && !testsPass) failures.push("npm test failed in the smoke repo");
  return failures;
}

const [mode, sessionsDir, repoDir] = process.argv.slice(2);
if (!mode || !sessionsDir || !repoDir) {
  console.error("usage: assert-run.mjs <mode> <sessions-dir> <repo-dir>");
  process.exit(2);
}
let failures;
let agents = [];
try {
  agents = mainSessionAgents(sessionsDir, repoDir);
  const changed = repoChanged(repoDir);
  const testsPass = EXPECT[mode]?.changes
    ? spawnSync("npm", ["test", "--silent"], { cwd: repoDir, stdio: "ignore" }).status === 0
    : true;
  failures = check(mode, agents, { changed, testsPass });
} catch (err) {
  failures = [err.message];
}
console.log(`\n--- smoke assertions (${mode}) ---\nagents spawned: [${agents.join(", ")}]`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(failures.length ? "smoke: FAIL" : "smoke: PASS");
process.exit(failures.length ? 1 : 0);
