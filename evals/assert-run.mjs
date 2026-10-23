#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LEVELS, parseRole } from "../lib/models.mjs";

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

const PERFORMANCE_AGENT = "nemo-performance";
const SAFE_SELECTOR = /^[A-Za-z0-9._@+/-][A-Za-z0-9._@+/:-]*$/;

function roleReference(value) {
  if (typeof value !== "string") return null;
  const match = /^@([A-Za-z0-9._-]+)(?::([a-z]+))?$/.exec(value);
  return match ? { name: match[1], thinking: match[2] } : null;
}

function configRecord(key) {
  const result = JSON.parse(execFileSync("omp", ["config", "get", key, "--json"], { encoding: "utf8" }));
  if (key === "task.agentAdvisor" && result?.key === key && result.value === undefined) return {};
  if (result?.key !== key || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    throw new Error(`expected ${key} config result with a record value`);
  }
  return result.value;
}

function performanceSelection(evidence, repoDir) {
  if (!evidence || evidence.cwd !== fs.realpathSync(repoDir)) throw new Error("performance evidence cwd does not match the smoke repo");
  const { modelRoles: roles, agentModelOverrides: overrides, agentAdvisor: advisors, models } = evidence;
  for (const [key, value] of Object.entries({ modelRoles: roles, agentModelOverrides: overrides, agentAdvisor: advisors })) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} evidence must be a record`);
  }
  const fallback = !Object.hasOwn(roles, "advisor-critical") && !Object.hasOwn(roles, "advisor");
  if (fallback && (advisors["nemo-implementer"] !== "off" || advisors["nemo-implementer-critical"] !== "off")) {
    throw new Error("reviewer fallback requires both implementer advisors off and neither advisor role configured");
  }
  const role = fallback ? "nemo-review" : "advisor-critical";
  const selector = roles[role];
  if (typeof selector !== "string" || !SAFE_SELECTOR.test(selector) || selector.startsWith("@")) {
    throw new Error(`modelRoles.${role} must be a configured concrete model selector`);
  }
  if (!Object.hasOwn(overrides, PERFORMANCE_AGENT)) {
    throw new Error("missing task.agentModelOverrides.nemo-performance; frontmatter/session fallback discovery is unverified");
  }
  const override = overrides[PERFORMANCE_AGENT];
  if (!Array.isArray(models) || !models.every((m) => m && typeof m.selector === "string"
    && SAFE_SELECTOR.test(m.selector) && typeof m.provider === "string"
    && (m.thinking === null || (Array.isArray(m.thinking) && m.thinking.every((level) => LEVELS.includes(level)))))) {
    throw new Error("performance model catalog evidence is malformed");
  }
  const required = parseRole(models, selector);
  if (!required) throw new Error(`configured ${role} model is unavailable or its thinking level is unsupported`);
  const reference = roleReference(override);
  const resolved = reference
    ? parseRole(models, Object.hasOwn(roles, reference.name) ? roles[reference.name] : undefined)
    : parseRole(models, override);
  const thinking = reference?.thinking ?? resolved?.thinking;
  if (!resolved || resolved.model.selector !== required.model.selector || thinking !== required.thinking
    || (reference?.thinking && !resolved.model.thinking?.includes(reference.thinking))) {
    throw new Error(`effective nemo-performance override must resolve to configured @${role} (${selector}), got ${JSON.stringify(override)}`);
  }
  return { role: `@${role}`, selector, fallback };
}

function capturePerformance(file) {
  const roles = configRecord("modelRoles");
  const overrides = configRecord("task.agentModelOverrides");
  const advisors = configRecord("task.agentAdvisor");
  const catalog = JSON.parse(execFileSync("omp", ["models", "--json"], { encoding: "utf8" }));
  if (!Array.isArray(catalog?.models)) throw new Error("expected model catalog with a models array");
  const pick = (record, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
  const override = overrides[PERFORMANCE_AGENT];
  const referencedRole = roleReference(override)?.name;
  const evidence = {
    cwd: fs.realpathSync(process.cwd()),
    modelRoles: pick(roles, ["advisor", "advisor-critical", "nemo-review", ...(referencedRole ? [referencedRole] : [])]),
    agentModelOverrides: pick(overrides, [PERFORMANCE_AGENT]),
    agentAdvisor: pick(advisors, ["nemo-implementer", "nemo-implementer-critical"]),
    models: catalog.models.filter((m) => m && (m.kind === undefined || m.kind === "chat"))
      .map((m) => ({ selector: m.selector, provider: m.provider, thinking: m.thinking ?? null })),
  };
  const selection = performanceSelection(evidence, process.cwd());
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`critical smoke: captured native nemo-performance selection ${selection.role} (${selection.selector})`);
  if (selection.fallback) console.log("critical smoke: explicit advisor-disabled/no-advisor-role fallback to @nemo-review");
}

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

function check(mode, calls, { changed, testsPass }) {
  const batches = calls.map((tasks) => tasks.map((task) => task.agent));
  const want = EXPECT[mode];
  if (!want) return [`unknown mode ${mode}`];
  const agents = batches.flat();
  const failures = [];
  for (const task of calls.flat()) {
    if (task.agent !== "seance" && Object.hasOwn(task, "model")) {
      failures.push(`${task.agent} uses unsupported ordinary per-call model override`);
    }
  }
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
  }
  if (want.changes && !changed) failures.push("expected a non-empty diff");
  if (!want.changes && changed) failures.push("expected no changes");
  if (want.changes && !testsPass) failures.push("npm test failed in the smoke repo");
  return failures;
}

if (process.argv[2] === "--capture-performance") {
  if (process.argv.length !== 4) {
    console.error("usage: assert-run.mjs --capture-performance <evidence-json>");
    process.exit(2);
  }
  try {
    capturePerformance(process.argv[3]);
  } catch (err) {
    console.error(`critical smoke model selection failed: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const [mode, sessionsDir, repoDir, performanceEvidencePath] = process.argv.slice(2);
if (!mode || !sessionsDir || !repoDir || (mode === "critical" && !performanceEvidencePath)) {
  console.error("usage: assert-run.mjs <mode> <sessions-dir> <repo-dir> <performance-evidence-json (required for critical)>");
  process.exit(2);
}
let failures;
let agents = [];
try {
  if (mode === "critical") {
    const selection = performanceSelection(JSON.parse(fs.readFileSync(performanceEvidencePath, "utf8")), repoDir);
    console.log(`critical smoke: captured native selection ${selection.role} (${selection.selector})${selection.fallback ? "; advisor-disabled fallback" : ""}`);
    console.log("Selection evidence is a pre-run config snapshot, not proof of live model use, unchanged configuration or gate completion.");
  }
  const calls = mainSessionTaskCalls(sessionsDir, repoDir);
  agents = calls.flat().map((task) => task.agent);
  const changed = repoChanged(repoDir);
  const testsPass = EXPECT[mode]?.changes
    ? spawnSync("npm", ["test", "--silent"], { cwd: repoDir, stdio: "ignore" }).status === 0
    : true;
  failures = check(mode, calls, { changed, testsPass });
} catch (err) {
  failures = [err.message];
}
console.log(`\n--- smoke assertions (${mode}) ---\nagents spawned: [${agents.join(", ")}]`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(failures.length ? "smoke: FAIL" : "smoke: PASS");
process.exit(failures.length ? 1 : 0);
