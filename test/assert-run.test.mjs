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
const assertRun = (mode, sessions, dir) =>
  spawnSync("node", [path.join(REPO, "evals", "assert-run.mjs"), mode, sessions, dir], { encoding: "utf8", env: cleanEnv });

const taskCall = (...agents) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "task", arguments: { tasks: agents.map((agent) => ({ agent, name: agent, task: "x" })) } }] },
});

function writeSession(file, header, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ type: "title", v: 1 }, { type: "session", ...header }, ...entries].map((e) => JSON.stringify(e)).join("\n"));
}

function run(mode, { dir, sessions }, calls) {
  writeSession(path.join(sessions, "main.jsonl"), { cwd: dir }, calls);
  const res = assertRun(mode, sessions, dir);
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

test("normal needs the full review batch", (t) => {
  const r = smokeRepo(t);
  const ok = run("normal", r, [taskCall("nemo-implementer"), taskCall("nemo-architect", "nemo-quality", "nemo-qa", "reviewer"), taskCall("nemo-final-review")]);
  assert.equal(ok.code, 0, ok.out);
  const missing = run("normal", r, [taskCall("nemo-implementer"), taskCall("nemo-architect", "nemo-quality", "nemo-qa"), taskCall("nemo-final-review")]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /missing agent reviewer/);
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
