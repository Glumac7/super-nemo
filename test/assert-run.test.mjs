import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MODELS, REPO } from "./helpers.mjs";

function smokeRepo(t, { change = true, passing = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-smoke-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "sn-sessions-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module", "scripts": { "test": "node --test" } }\n');
  fs.writeFileSync(path.join(dir, "math.test.js"), 'import { test } from "node:test";\ntest("ok", () => {});\n');
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "init");
  if (change) fs.writeFileSync(path.join(dir, "math.js"), "export const sub = (a, b) => a - b;\n");
  if (!passing) fs.writeFileSync(path.join(dir, "math.test.js"), 'import { test } from "node:test";\ntest("bad", () => { throw new Error("x"); });\n');
  return { dir, sessions };
}

const { NODE_TEST_CONTEXT, ...cleanEnv } = process.env;
const assertRun = (mode, sessions, dir, evidencePath) =>
  spawnSync("node", [path.join(REPO, "evals", "assert-run.mjs"), mode, sessions, dir, ...(evidencePath === undefined ? [] : [evidencePath])], { encoding: "utf8", env: cleanEnv });

const taskCall = (...agents) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "task", arguments: { tasks: agents.map((agent) => typeof agent === "string" ? { agent, name: agent, task: "x" } : agent) } }] },
});

function writeSession(file, header, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ type: "title", v: 1 }, { type: "session", ...header }, ...entries].map((e) => JSON.stringify(e)).join("\n"));
}

function performanceEvidence(dir) {
  return {
    cwd: fs.realpathSync(dir),
    modelRoles: { "advisor-critical": "alpha/big:high", "nemo-review": "beta/sol:high" },
    agentModelOverrides: { "nemo-performance": "@advisor-critical" },
    agentAdvisor: {},
    models: JSON.parse(fs.readFileSync(MODELS, "utf8")).models,
  };
}

function run(mode, { dir, sessions }, calls, evidence = performanceEvidence(dir)) {
  writeSession(path.join(sessions, "main.jsonl"), { cwd: dir }, calls);
  const evidencePath = path.join(sessions, "performance.json");
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const res = assertRun(mode, sessions, dir, mode === "critical" ? evidencePath : undefined);
  return { code: res.status, out: res.stdout + res.stderr };
}

test("light passes with exactly one nemo-quality and ignores subagent sessions", (t) => {
  const r = smokeRepo(t);
  writeSession(path.join(r.sessions, "main", "Impl.jsonl"), { cwd: r.dir, parentSession: "main.jsonl" }, [taskCall("nemo-implementer")]);
  const res = run("light", r, [taskCall("nemo-quality")]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /smoke: PASS/);
});

test("light fails when an implementer was spawned", (t) => {
  const res = run("light", smokeRepo(t), [taskCall("nemo-implementer"), taskCall("nemo-quality")]);
  assert.equal(res.code, 1);
  assert.match(res.out, /expected agents exactly \[nemo-quality\]/);
});

for (const mode of ["normal", "critical", "auto", "implicit"]) {
  const implementer = mode === "critical" ? "nemo-implementer-critical" : "nemo-implementer";
  const reviewers = ["nemo-architect", "nemo-quality", "nemo-qa", "reviewer"];
  if (mode === "critical") reviewers.push("nemo-security", "nemo-performance");

  test(`${mode} passes with a tester and the complete workflow`, (t) => {
    const res = run(mode, smokeRepo(t), [
      taskCall(implementer),
      taskCall("nemo-tester"),
      taskCall(...reviewers),
      taskCall("nemo-final-review"),
    ]);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /smoke: PASS/);
  });

  test(`${mode} rejects an otherwise complete workflow without the tester`, (t) => {
    const res = run(mode, smokeRepo(t), [
      taskCall(implementer),
      taskCall(...reviewers),
      taskCall("nemo-final-review"),
    ]);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /missing agent nemo-tester/);
    assert.match(res.out, /smoke: FAIL/);
  });

  for (const { name, calls, diagnostic } of [
    {
      name: "tester-only",
      calls: [taskCall("nemo-tester")],
      diagnostic: /missing agent nemo-implementer/,
    },
    {
      name: "missing implementer",
      calls: [taskCall("nemo-tester"), taskCall(...reviewers), taskCall("nemo-final-review")],
      diagnostic: /missing agent nemo-implementer/,
    },
    {
      name: "tester before implementation even when another tester follows",
      calls: [
        taskCall("nemo-tester"),
        taskCall(implementer),
        taskCall("nemo-tester"),
        taskCall(...reviewers),
        taskCall("nemo-final-review"),
      ],
      diagnostic: /tester.*after|separate task call/,
    },
    {
      name: "implementer and tester in the same task call",
      calls: [taskCall(implementer, "nemo-tester"), taskCall(...reviewers), taskCall("nemo-final-review")],
      diagnostic: /tester.*after|separate task call/,
    },
  ]) {
    test(`${mode} rejects ${name}`, (t) => {
      const res = run(mode, smokeRepo(t), calls);
      assert.equal(res.code, 1, res.out);
      assert.match(res.out, diagnostic);
      assert.match(res.out, /smoke: FAIL/);
    });
  }

  if (mode === "auto" || mode === "implicit") {
    test(`${mode} rejects an otherwise complete workflow without QA`, (t) => {
      const res = run(mode, smokeRepo(t), [
        taskCall(implementer),
        taskCall("nemo-tester"),
        taskCall(...reviewers.filter((agent) => agent !== "nemo-qa")),
        taskCall("nemo-final-review"),
      ]);
      assert.equal(res.code, 1, res.out);
      assert.match(res.out, /missing agent nemo-qa/);
      assert.match(res.out, /smoke: FAIL/);
    });
  }
}

test("normal still requires the native reviewer when the tester is present", (t) => {
  const res = run("normal", smokeRepo(t), [
    taskCall("nemo-implementer"),
    taskCall("nemo-tester"),
    taskCall("nemo-architect", "nemo-quality", "nemo-qa"),
    taskCall("nemo-final-review"),
  ]);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /missing agent reviewer/);
});

test("critical requires performance review in the main session", (t) => {
  const r = smokeRepo(t);
  const calls = [
    taskCall("nemo-implementer-critical"),
    taskCall("nemo-tester"),
    taskCall("nemo-architect", "nemo-security", "nemo-quality", "nemo-qa", "reviewer"),
    taskCall("nemo-final-review"),
  ];
  const missing = run("critical", r, calls);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /missing agent nemo-performance/);

  writeSession(path.join(r.sessions, "main", "Impl.jsonl"), { cwd: r.dir, parentSession: "main.jsonl" }, [taskCall("nemo-performance")]);
  const subagentOnly = run("critical", r, calls);
  assert.equal(subagentOnly.code, 1);
  assert.match(subagentOnly.out, /missing agent nemo-performance/);

  const ok = run("critical", r, [
    calls[0],
    calls[1],
    criticalBatch(),
    calls[3],
  ]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /smoke: PASS/);
});

function criticalBatch() {
  return taskCall("nemo-architect", "nemo-security", "nemo-quality", "nemo-qa", "nemo-performance", "reviewer");
}

test("critical rejects performance dispatched separately or after final review", (t) => {
  const r = smokeRepo(t);
  const review = taskCall("nemo-architect", "nemo-security", "nemo-quality", "nemo-qa", "reviewer");
  const performance = taskCall("nemo-performance");
  const impl = taskCall("nemo-implementer-critical");
  const tester = taskCall("nemo-tester");
  const final = taskCall("nemo-final-review");
  for (const calls of [
    [impl, tester, review, performance, final],
    [impl, tester, review, final, performance],
    [impl, tester, final, criticalBatch()],
    [impl, tester, final, criticalBatch(), final],
  ]) {
    const res = run("critical", r, calls);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /full critical review batch before nemo-final-review/);
  }
  const preplan = run("critical", r, [
    taskCall("nemo-architect"), impl, tester, criticalBatch(), final,
  ]);
  assert.equal(preplan.code, 0, preplan.out);
});

const criticalCalls = () => [
  taskCall("nemo-implementer-critical"), taskCall("nemo-tester"), criticalBatch(), taskCall("nemo-final-review"),
];

test("ordinary per-call models are rejected even with usable native performance selection", (t) => {
  const r = smokeRepo(t);
  for (const agent of ["nemo-performance", "nemo-tester", "nemo-implementer-critical"]) {
    const calls = criticalCalls();
    for (const call of calls) {
      for (const task of call.message.content[0].arguments.tasks) {
        if (task.agent === agent) task.model = "@advisor-critical";
      }
    }
    const res = run("critical", r, calls);
    assert.equal(res.code, 1, res.out);
  }
});

for (const override of ["@advisor-critical", "@custom", "alpha/big:high", "@custom:high"]) {
  test(`critical accepts equivalent native performance selection ${override}`, (t) => {
    const r = smokeRepo(t);
    const evidence = performanceEvidence(r.dir);
    evidence.modelRoles.custom = override === "@custom:high" ? "alpha/big:medium" : "alpha/big:high";
    evidence.agentModelOverrides["nemo-performance"] = override;
    const res = run("critical", r, criticalCalls(), evidence);
    assert.equal(res.code, 0, res.out);
  });
}

test("critical rejects missing, weaker, unavailable and thinking-mismatched native selection", (t) => {
  const r = smokeRepo(t);
  for (const mutate of [
    (e) => { delete e.agentModelOverrides["nemo-performance"]; },
    (e) => { e.agentModelOverrides["nemo-performance"] = "@nemo-review"; },
    (e) => { e.agentModelOverrides["nemo-performance"] = "alpha/big:medium"; },
    (e) => { e.agentModelOverrides["nemo-performance"] = "@missing"; },
    (e) => { e.modelRoles["advisor-critical"] = "absent/model:high"; },
    (e) => { e.modelRoles["advisor-critical"] = "alpha/big:impossible"; },
    (e) => { e.modelRoles.custom = "alpha/plain"; e.agentModelOverrides["nemo-performance"] = "@custom:high"; },
  ]) {
    const evidence = performanceEvidence(r.dir);
    mutate(evidence);
    const res = run("critical", r, criticalCalls(), evidence);
    assert.equal(res.code, 1, res.out);
  }
});

test("reviewer fallback requires both implementer advisors off and no advisor roles", (t) => {
  const r = smokeRepo(t);
  const fallback = performanceEvidence(r.dir);
  delete fallback.modelRoles["advisor-critical"];
  fallback.agentAdvisor = { "nemo-implementer": "off", "nemo-implementer-critical": "off" };
  fallback.agentModelOverrides["nemo-performance"] = "@nemo-review";
  assert.equal(run("critical", r, criticalCalls(), fallback).code, 0);
  for (const mutate of [
    (e) => { delete e.agentAdvisor["nemo-implementer"]; },
    (e) => { e.agentAdvisor["nemo-implementer-critical"] = "on"; },
    (e) => { e.modelRoles.advisor = "alpha/big:medium"; },
    (e) => { e.modelRoles["advisor-critical"] = ""; },
  ]) {
    const evidence = structuredClone(fallback);
    mutate(evidence);
    const res = run("critical", r, criticalCalls(), evidence);
    assert.equal(res.code, 1, res.out);
  }
});

test("critical requires well-formed evidence for this repository", (t) => {
  const r = smokeRepo(t);
  writeSession(path.join(r.sessions, "main.jsonl"), { cwd: r.dir }, criticalCalls());
  assert.equal(assertRun("critical", r.sessions, r.dir).status, 2);
  const evidencePath = path.join(r.sessions, "invalid.json");
  for (const text of ["not json", "null", "[]", JSON.stringify({ ...performanceEvidence(r.dir), cwd: r.sessions }),
    JSON.stringify({ ...performanceEvidence(r.dir), models: null }),
    JSON.stringify({ ...performanceEvidence(r.dir), agentAdvisor: [] })]) {
    fs.writeFileSync(evidencePath, text);
    const res = assertRun("critical", r.sessions, r.dir, evidencePath);
    assert.equal(res.status, 1, res.stdout + res.stderr);
  }
});

test("an empty diff or failing tests fail the run", (t) => {
  const empty = run("light", smokeRepo(t, { change: false }), [taskCall("nemo-quality")]);
  assert.equal(empty.code, 1);
  assert.match(empty.out, /expected a non-empty diff/);
  const failing = run("light", smokeRepo(t, { passing: false }), [taskCall("nemo-quality")]);
  assert.equal(failing.code, 1);
  assert.match(failing.out, /npm test failed/);
});

test("a session for another directory is not taken as the main session", (t) => {
  const r = smokeRepo(t);
  writeSession(path.join(r.sessions, "main.jsonl"), { cwd: os.tmpdir() }, [taskCall("nemo-quality")]);
  const res = assertRun("light", r.sessions, r.dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /expected exactly one main session/);
});

function smokeScript(t, records, { configStatus = 0, mode = "critical", capture = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-smoke-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "calls.jsonl");
  fs.writeFileSync(path.join(root, "omp"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "config") {
  const records = JSON.parse(process.env.SMOKE_RECORDS);
  process.stdout.write(records[args[2]]);
  process.exit(Number(process.env.SMOKE_CONFIG_STATUS));
}
if (args[0] === "models") {
  process.stdout.write(process.env.SMOKE_CATALOG);
  process.exit(0);
}
if (args[0] !== "-p") process.exit(4);
const sessions = args[args.indexOf("--session-dir") + 1];
const call = (tasks) => ({ type: "message", message: { role: "assistant", content: [
  { type: "toolCall", name: "task", arguments: { tasks } }
] } });
const agent = (name) => ({ agent: name });
const entries = process.env.SMOKE_MODE === "critical" ? [
  call([agent("nemo-implementer-critical")]),
  call([agent("nemo-tester")]),
  call(["nemo-architect", "nemo-security", "nemo-quality", "nemo-qa", "reviewer", "nemo-performance"].map(agent)),
  call([agent("nemo-final-review")]),
] : [call([agent("nemo-quality")])];
fs.writeFileSync(path.join(sessions, "main.jsonl"), [
  { type: "session", cwd: process.cwd() }, ...entries,
].map((entry) => JSON.stringify(entry)).join("\\n"));
fs.appendFileSync("math.js", "export const sub = (a, b) => a - b;\\n");
`, { mode: 0o755 });
  const evidencePath = path.join(root, "performance.json");
  const args = capture
    ? [path.join(REPO, "evals", "assert-run.mjs"), "--capture-performance", evidencePath]
    : [path.join(REPO, "evals", "smoke.sh"), mode];
  const res = spawnSync(capture ? process.execPath : "bash", args, {
    encoding: "utf8", cwd: root,
    env: {
      ...cleanEnv, PATH: `${root}${path.delimiter}${cleanEnv.PATH}`,
      SMOKE_CALLS: log, SMOKE_RECORDS: JSON.stringify(records), SMOKE_CATALOG: fs.readFileSync(MODELS, "utf8"),
      SMOKE_CONFIG_STATUS: String(configStatus), SMOKE_MODE: mode,
    },
  });
  return {
    code: res.status, out: res.stdout + res.stderr,
    calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    evidence: fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, "utf8")) : undefined,
    cwd: fs.realpathSync(root),
  };
}

function configRecords() {
  const e = performanceEvidence(os.tmpdir());
  return Object.fromEntries([
    ["modelRoles", e.modelRoles], ["task.agentModelOverrides", e.agentModelOverrides], ["task.agentAdvisor", e.agentAdvisor],
  ].map(([key, value]) => [key, JSON.stringify({ key, value })]));
}

test("critical smoke captures native selection then evaluates a workflow without per-call models", (t) => {
  const ok = smokeScript(t, configRecords());
  assert.equal(ok.code, 0, ok.out);
  assert.ok(ok.calls.some((args) => args[0] === "models"));
  assert.ok(ok.calls.some((args) => args[0] === "-p"));
});

test("capture accepts an omitted advisor-record value and retains only selection evidence", (t) => {
  const records = configRecords();
  records["task.agentAdvisor"] = JSON.stringify({ key: "task.agentAdvisor" });
  records.modelRoles = JSON.stringify({ key: "modelRoles", value: {
    "advisor-critical": "alpha/big:high", "nemo-review": "beta/sol:high", custom: "alpha/big:high", unrelated: "alpha/plain",
  } });
  records["task.agentModelOverrides"] = JSON.stringify({ key: "task.agentModelOverrides", value: {
    "nemo-performance": "@custom", unrelated: "alpha/plain",
  } });
  const res = smokeScript(t, records, { capture: true });
  assert.equal(res.code, 0, res.out);
  assert.equal(res.evidence.cwd, res.cwd);
  assert.deepEqual(res.evidence.agentAdvisor, {});
  assert.equal(res.evidence.modelRoles.custom, "alpha/big:high");
  assert.equal(Object.hasOwn(res.evidence.modelRoles, "unrelated"), false);
  assert.deepEqual(res.evidence.agentModelOverrides, { "nemo-performance": "@custom" });
  assert.ok(res.evidence.models.some((model) => model.selector === "alpha/big"));
  assert.equal(res.calls.some((args) => args[0] === "-p"), false);
});

test("critical smoke supports explicit advisor-disabled fallback", (t) => {
  const records = configRecords();
  records.modelRoles = JSON.stringify({ key: "modelRoles", value: { "nemo-review": "beta/sol:high" } });
  records["task.agentModelOverrides"] = JSON.stringify({ key: "task.agentModelOverrides", value: { "nemo-performance": "@nemo-review" } });
  records["task.agentAdvisor"] = JSON.stringify({ key: "task.agentAdvisor", value: {
    "nemo-implementer": "off", "nemo-implementer-critical": "off",
  } });
  const res = smokeScript(t, records);
  assert.equal(res.code, 0, res.out);
});

test("critical smoke blocks malformed records and unusable native mapping before provider dispatch", (t) => {
  for (const [key, value] of [
    ["modelRoles", "not json"],
    ["modelRoles", JSON.stringify({ key: "other", value: {} })],
    ["task.agentAdvisor", JSON.stringify({ key: "task.agentAdvisor", value: [] })],
    ["task.agentModelOverrides", JSON.stringify({ key: "task.agentModelOverrides", value: {} })],
    ["task.agentModelOverrides", JSON.stringify({ key: "task.agentModelOverrides", value: { "nemo-performance": "@nemo-review" } })],
  ]) {
    const records = configRecords();
    records[key] = value;
    const res = smokeScript(t, records);
    assert.equal(res.code, 1, res.out);
    assert.equal(res.calls.some((args) => args[0] === "-p"), false);
  }
  const unavailable = smokeScript(t, configRecords(), { configStatus: 1 });
  assert.equal(unavailable.code, 1, unavailable.out);
  assert.equal(unavailable.calls.some((args) => args[0] === "-p"), false);
});

test("noncritical smoke does not query performance configuration", (t) => {
  const res = smokeScript(t, {}, { mode: "light", configStatus: 1 });
  assert.equal(res.code, 0, res.out);
  assert.equal(res.calls.length, 1);
  assert.equal(res.calls[0][0], "-p");
});
