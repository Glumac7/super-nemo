import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { REPO } from "./helpers.mjs";

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
const assertRun = (mode, sessions, dir, expectedModel) =>
  spawnSync("node", [path.join(REPO, "evals", "assert-run.mjs"), mode, sessions, dir, ...(expectedModel === undefined ? [] : [expectedModel])], { encoding: "utf8", env: cleanEnv });

const taskCall = (...agents) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "task", arguments: { tasks: agents.map((agent) => typeof agent === "string" ? { agent, name: agent, task: "x" } : agent) } }] },
});

function writeSession(file, header, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ type: "title", v: 1 }, { type: "session", ...header }, ...entries].map((e) => JSON.stringify(e)).join("\n"));
}

function run(mode, { dir, sessions }, calls, expectedModel) {
  writeSession(path.join(sessions, "main.jsonl"), { cwd: dir }, calls);
  const res = assertRun(mode, sessions, dir, expectedModel);
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
  const expectedModel = mode === "critical" ? "@advisor-critical" : undefined;
  if (mode === "critical") reviewers.push("nemo-security", { agent: "nemo-performance", model: expectedModel });

  test(`${mode} passes with a tester and the complete workflow`, (t) => {
    const res = run(mode, smokeRepo(t), [
      taskCall(implementer),
      taskCall("nemo-tester"),
      taskCall(...reviewers),
      taskCall("nemo-final-review"),
    ], expectedModel);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /smoke: PASS/);
  });

  test(`${mode} rejects an otherwise complete workflow without the tester`, (t) => {
    const res = run(mode, smokeRepo(t), [
      taskCall(implementer),
      taskCall(...reviewers),
      taskCall("nemo-final-review"),
    ], expectedModel);
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
      const res = run(mode, smokeRepo(t), calls, expectedModel);
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
  const missing = run("critical", r, calls, "@advisor-critical");
  assert.equal(missing.code, 1);
  assert.match(missing.out, /missing agent nemo-performance/);

  writeSession(path.join(r.sessions, "main", "Impl.jsonl"), { cwd: r.dir, parentSession: "main.jsonl" }, [taskCall({ agent: "nemo-performance", model: "@advisor-critical" })]);
  const subagentOnly = run("critical", r, calls, "@advisor-critical");
  assert.equal(subagentOnly.code, 1);
  assert.match(subagentOnly.out, /missing agent nemo-performance/);

  const ok = run("critical", r, [
    calls[0],
    calls[1],
    criticalBatch("@advisor-critical"),
    calls[3],
  ], "@advisor-critical");
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /smoke: PASS/);
});

function criticalBatch(model) {
  return taskCall("nemo-architect", "nemo-security", "nemo-quality", "nemo-qa",
    { agent: "nemo-performance", ...(model === undefined ? {} : { model }) }, "reviewer");
}

test("critical rejects performance dispatched separately or after final review", (t) => {
  const r = smokeRepo(t);
  const review = taskCall("nemo-architect", "nemo-security", "nemo-quality", "nemo-qa", "reviewer");
  const performance = taskCall({ agent: "nemo-performance", model: "@advisor-critical" });
  const impl = taskCall("nemo-implementer-critical");
  const tester = taskCall("nemo-tester");
  const final = taskCall("nemo-final-review");
  for (const calls of [
    [impl, tester, review, performance, final],
    [impl, tester, review, final, performance],
    [impl, tester, final, criticalBatch("@advisor-critical")],
    [impl, tester, final, criticalBatch("@advisor-critical"), final],
  ]) {
    const res = run("critical", r, calls, "@advisor-critical");
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /full critical review batch before nemo-final-review/);
  }
  const preplan = run("critical", r, [
    taskCall("nemo-architect"), impl, tester, criticalBatch("@advisor-critical"), final,
  ], "@advisor-critical");
  assert.equal(preplan.code, 0, preplan.out);
});

test("critical requires the expected explicit performance model override", (t) => {
  const r = smokeRepo(t);
  for (const model of [undefined, "@default", "@nemo-review"]) {
    const res = run("critical", r, [
      taskCall("nemo-implementer-critical"), taskCall("nemo-tester"), criticalBatch(model), taskCall("nemo-final-review"),
    ], "@advisor-critical");
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /nemo-performance requires explicit model @advisor-critical/);
  }
});

test("critical requires an allowed model expectation and supports explicit reviewer fallback", (t) => {
  const r = smokeRepo(t);
  const calls = [taskCall("nemo-implementer-critical"), taskCall("nemo-tester"), criticalBatch("@nemo-review"), taskCall("nemo-final-review")];
  for (const expected of [undefined, "@default", ""]) {
    const res = run("critical", r, calls, expected);
    assert.equal(res.code, 2, res.out);
    assert.match(res.out, /expected-performance-model/);
  }
  const ok = run("critical", r, calls, "@nemo-review");
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /smoke: PASS/);
  const missing = run("critical", r, [
    calls[0], calls[1], criticalBatch(), calls[3],
  ], "@nemo-review");
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /nemo-performance requires explicit model @nemo-review/);
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

function smokeScript(t, roles, { model = "@advisor-critical", configStatus = 0, mode = "critical" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-smoke-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "calls.jsonl");
  fs.writeFileSync(path.join(root, "omp"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "config") {
  if (JSON.stringify(args) !== JSON.stringify(["config", "get", "modelRoles", "--json"])) process.exit(3);
  process.stdout.write(process.env.SMOKE_ROLES);
  process.exit(Number(process.env.SMOKE_CONFIG_STATUS));
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
  call(["nemo-architect", "nemo-security", "nemo-quality", "nemo-qa", "reviewer"].map(agent).concat(
    { agent: "nemo-performance", model: process.env.SMOKE_MODEL })),
  call([agent("nemo-final-review")]),
] : [call([agent("nemo-quality")])];
fs.writeFileSync(path.join(sessions, "main.jsonl"), [
  { type: "session", cwd: process.cwd() }, ...entries,
].map((entry) => JSON.stringify(entry)).join("\\n"));
fs.appendFileSync("math.js", "export const sub = (a, b) => a - b;\\n");
`, { mode: 0o755 });
  const res = spawnSync("bash", [path.join(REPO, "evals", "smoke.sh"), mode], {
    encoding: "utf8",
    env: {
      ...cleanEnv, PATH: `${root}${path.delimiter}${cleanEnv.PATH}`,
      SMOKE_CALLS: log, SMOKE_ROLES: roles, SMOKE_MODEL: model,
      SMOKE_CONFIG_STATUS: String(configStatus), SMOKE_MODE: mode,
    },
  });
  return {
    code: res.status, out: res.stdout + res.stderr,
    calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
  };
}

test("critical smoke queries the parent role record and passes the configured critical expectation", (t) => {
  const roles = JSON.stringify({ key: "modelRoles", value: { "advisor-critical": "alpha/big:high", "nemo-review": "beta/sol:high" } });
  const ok = smokeScript(t, roles);
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(ok.calls[0], ["config", "get", "modelRoles", "--json"]);
  assert.match(ok.out, /smoke: PASS/);
  const wrong = smokeScript(t, roles, { model: "@nemo-review" });
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /nemo-performance requires explicit model @advisor-critical/);
});

test("critical smoke explicitly selects the configured advisor-disabled reviewer fallback", (t) => {
  const ok = smokeScript(t, JSON.stringify({ key: "modelRoles", value: { "nemo-review": "beta/sol:high" } }), { model: "@nemo-review" });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /explicit advisor-disabled fallback to @nemo-review/);
  assert.match(ok.out, /smoke: PASS/);
});

test("critical smoke fails unavailable or malformed role choices before dispatch", (t) => {
  for (const roles of [
    "not json", "null", "[]", "{}",
    '{"advisor-critical":"alpha/big:high"}',
    '{"key":"other","value":{"advisor-critical":"alpha/big:high"}}',
    ...[null, [], {}, { "advisor-critical": "", "nemo-review": "beta/sol:high" },
      { "advisor-critical": null, "nemo-review": "beta/sol:high" },
      { "advisor-critical": 42, "nemo-review": "beta/sol:high" },
      { "advisor-critical": "   ", "nemo-review": "beta/sol:high" },
      { "advisor": "alpha/big:medium", "nemo-review": "beta/sol:high" },
      { "nemo-review": "" }, { "nemo-review": [] },
    ].map((value) => JSON.stringify({ key: "modelRoles", value })),
  ]) {
    const res = smokeScript(t, roles);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /critical smoke model selection failed/);
    assert.equal(res.calls.length, 1, "no provider dispatch on invalid configuration");
  }
  const unavailable = smokeScript(t, "{}", { configStatus: 1 });
  assert.equal(unavailable.code, 1, unavailable.out);
  assert.equal(unavailable.calls.length, 1);
});

test("noncritical smoke does not query model roles or require a performance expectation", (t) => {
  const res = smokeScript(t, "not json", { mode: "light", configStatus: 1 });
  assert.equal(res.code, 0, res.out);
  assert.equal(res.calls.length, 1);
  assert.equal(res.calls[0][0], "-p");
  assert.match(res.out, /smoke: PASS/);
});
