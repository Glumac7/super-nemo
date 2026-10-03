#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const NORMAL_EXPECT = {
  includes: ["nemo-implementer", "nemo-tester", "nemo-architect", "nemo-quality", "nemo-qa", "reviewer", "nemo-final-review"],
  implementer: "nemo-implementer",
  changes: true,
};

const EXPECT = {
  light: { exactly: ["nemo-quality"], forbidPrefix: "nemo-implementer", changes: true },
  normal: NORMAL_EXPECT,
  critical: {
    includes: [
      "nemo-implementer-critical",
      "nemo-tester",
      "nemo-architect",
      "nemo-security",
      "nemo-quality",
      "nemo-qa",
      "nemo-performance",
      "reviewer",
      "nemo-final-review",
    ],
    implementer: "nemo-implementer-critical",
    changes: true,
  },
  auto: NORMAL_EXPECT,
  implicit: NORMAL_EXPECT,
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

function mainSessionTaskCalls(sessionsDir, repoDir) {
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
  const calls = [];
  for (const entry of mains[0]) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    for (const part of entry.message.content ?? []) {
      if (part?.type !== "toolCall" || part.name !== "task") continue;
      calls.push((part.arguments?.tasks ?? []).filter((task) => typeof task?.agent === "string"));
    }
  }
  return calls;
}

function repoChanged(repoDir) {
  const git = (...args) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  const root = git("rev-list", "--max-parents=0", "HEAD").trim().split("\n")[0];
  const tracked = spawnSync("git", ["diff", "--quiet", root], { cwd: repoDir }).status !== 0;
  return tracked || git("ls-files", "--others", "--exclude-standard").trim() !== "";
}

function check(mode, calls, { changed, testsPass, expectedPerformanceModel }) {
  const batches = calls.map((tasks) => tasks.map((task) => task.agent));
  const want = EXPECT[mode];
  if (!want) return [`unknown mode ${mode}`];
  const agents = batches.flat();
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
  if (want.implementer) {
    const implementerBatch = batches.findIndex((batch) => batch.includes(want.implementer));
    const testerBatch = batches.findIndex((batch) => batch.includes("nemo-tester"));
    // Dispatch order is observable here; awaiting and source integration are not.
    if (testerBatch !== -1 && (implementerBatch === -1 || implementerBatch >= testerBatch)) {
      failures.push(`expected nemo-tester after ${want.implementer} in a separate task call`);
    }
  }
  if (mode === "critical") {
    const reviewers = ["nemo-architect", "nemo-security", "nemo-quality", "nemo-qa", "nemo-performance", "reviewer"];
    const finalIndex = calls.findIndex((tasks) => tasks.some((task) => task.agent === "nemo-final-review"));
    const reviewBatch = calls.some((tasks, index) =>
      index < finalIndex && reviewers.every((agent) => tasks.some((task) => task.agent === agent)));
    if (!reviewBatch) failures.push("expected the full critical review batch before nemo-final-review");
    for (const task of calls.flat().filter((task) => task.agent === "nemo-performance")) {
      if (task.model !== expectedPerformanceModel) {
        failures.push(`nemo-performance requires explicit model ${expectedPerformanceModel}, got ${JSON.stringify(task.model) ?? "missing"}`);
      }
    }
  }
  if (want.changes && !changed) failures.push("expected a non-empty diff");
  if (!want.changes && changed) failures.push("expected no changes");
  if (want.changes && !testsPass) failures.push("npm test failed in the smoke repo");
  return failures;
}

const [mode, sessionsDir, repoDir, expectedPerformanceModel] = process.argv.slice(2);
if (!mode || !sessionsDir || !repoDir ||
    (mode === "critical" && !["@advisor-critical", "@nemo-review"].includes(expectedPerformanceModel))) {
  console.error("usage: assert-run.mjs <mode> <sessions-dir> <repo-dir> <expected-performance-model (required for critical: @advisor-critical|@nemo-review)>");
  process.exit(2);
}
let failures;
let agents = [];
try {
  const calls = mainSessionTaskCalls(sessionsDir, repoDir);
  agents = calls.flat().map((task) => task.agent);
  const changed = repoChanged(repoDir);
  const testsPass = EXPECT[mode]?.changes
    ? spawnSync("npm", ["test", "--silent"], { cwd: repoDir, stdio: "ignore" }).status === 0
    : true;
  failures = check(mode, calls, { changed, testsPass, expectedPerformanceModel });
} catch (err) {
  failures = [err.message];
}
console.log(`\n--- smoke assertions (${mode}) ---\nagents spawned: [${agents.join(", ")}]`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(failures.length ? "smoke: FAIL" : "smoke: PASS");
process.exit(failures.length ? 1 : 0);
