import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findVerdict, missing, policy, register, score, securityNote, treeOf, writeTargets } from "../lib/gate.mjs";

const blocked = (...a) => policy(...a)?.block === true;

test("write targets include edit patch headers, ast_edit paths and write paths", () => {
  assert.deepEqual(writeTargets("edit", { input: "[src/a.ts#AB12]\n+x\n*** Update File: src/b.ts\n*** Move to: src/c.ts" }).sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.deepEqual(writeTargets("ast_edit", { paths: ["src/x.ts"] }), ["src/x.ts"]);
  assert.deepEqual(writeTargets("write", { path: "[src/y.ts#TAG]" }), ["src/y.ts"]);
  assert.deepEqual(writeTargets("write", { path: "agent://1" }), []);
  assert.deepEqual(writeTargets("read", { path: "src/a.ts" }), []);
});

test("ownership: tester writes only tests/fixtures, implementers never write tests", () => {
  assert.ok(blocked("nemo-tester", "write", { path: "src/app.ts" }));
  assert.ok(!blocked("nemo-tester", "write", { path: "/tmp/target/test/app.test.ts" }));
  assert.ok(!blocked("nemo-tester", "write", { path: "test/fixtures/data.json" }));
  assert.ok(blocked("nemo-implementer", "edit", { input: "[src/__tests__/a.test.ts#AB]" }));
  assert.ok(blocked("nemo-implementer-critical", "write", { path: "tests/test_auth.py" }));
  assert.ok(!blocked("nemo-implementer", "write", { path: "src/app.ts" }));
  assert.ok(!blocked("", "write", { path: "test/app.test.ts" }), "the orchestrator writes LIGHT tests");
});

test("read-only reviewers cannot change files through bash", () => {
  for (const cmd of ["echo x > a.txt", "sed -i '' s/a/b/ f", "git commit -m x", "npm install left-pad", "rm -rf dist", "cp a b"]) {
    assert.ok(blocked("nemo-qa", "bash", { command: cmd }), cmd);
  }
  for (const cmd of ["npm test 2>&1 | tail -5", "git diff --stat", "node --test > /dev/null", "rg foo src"]) {
    assert.ok(!blocked("nemo-performance", "bash", { command: cmd }), cmd);
  }
  assert.ok(!blocked("nemo-implementer", "bash", { command: "echo x > a.txt" }), "authors may write");
});

test("secrets are never read or written; example files are fine", () => {
  assert.ok(blocked("", "read", { path: ".env" }));
  assert.ok(blocked("nemo-quality", "grep", { pattern: "KEY", path: "config/.env.production" }));
  assert.ok(blocked("", "bash", { command: "cat .env.local | head" }));
  assert.ok(blocked("", "read", { path: "keys/server.pem" }));
  assert.ok(blocked("nemo-implementer", "write", { path: ".env" }));
  assert.ok(!blocked("", "read", { path: ".env.example" }));
  assert.ok(!blocked("", "read", { path: "src/environment.ts" }));
});

test("risky edits get a security note, tests do not", () => {
  assert.match(securityNote("write", { path: "src/a.js", content: "el.innerHTML = html" }), /innerHTML/);
  assert.match(securityNote("edit", { input: "[app.py#AB]\n+subprocess.run(cmd, shell=True)" }), /shell=True/);
  assert.equal(securityNote("write", { path: "src/a.js", content: "const x = 1" }), null);
  assert.equal(securityNote("write", { path: "test/a.test.js", content: "eval(x)" }), null);
});

test("risk floor follows the verify-gate scoring", () => {
  assert.equal(score(["src/auth/session.ts"], 5, "+x", "").floor, "CRITICAL");
  assert.equal(score(["src/a.ts"], 5, "+eval(input)", "").floor, "CRITICAL");
  assert.equal(score(["package.json"], 2, "+x", "").floor, "NORMAL");
  assert.equal(score(["src/a.ts"], 4, "+x", "-  throw new Error('bad')").floor, "NORMAL");
  assert.equal(score(["src/a.ts"], 4, "+x", "").floor, "LIGHT");
  assert.equal(score(["README.md"], 300, "+x", "").floor, "LIGHT");
  assert.equal(score(["src/a.ts"], 4, "+} catch (e) {}", "").errorHandling, true);
});

test("missing gates by mode, receipts and code state", () => {
  const run = (spawned, receipts) => ({ spawned: new Set(spawned), receipts });
  const low = { floor: "LIGHT", reasons: [], errorHandling: false };
  assert.deepEqual(missing(run([], [{ agent: "nemo-quality", verdict: "FIX_REQUIRED", tree: "t0" }]), low, "t1").items, []);
  assert.deepEqual(missing(run([], []), low, "t1").items, ["nemo-quality: no verdict yet"]);

  const normal = ["nemo-implementer", "nemo-tester"];
  const pass = (agent, tree = "t1") => ({ agent, verdict: "PASS", tree });
  const all = [pass("nemo-architect", "t0"), pass("nemo-quality", "t0"), pass("nemo-qa", "t0"), pass("nemo-final-review")];
  assert.deepEqual(missing(run(normal, all), low, "t1").items, []);
  assert.match(missing(run(normal, all), low, "t2").items.join(), /final-review: PASS was for an earlier code state/);
  assert.match(missing(run(normal, [...all, { agent: "nemo-qa", verdict: "FIX_REQUIRED", tree: "t1" }]), low, "t1").items.join(), /nemo-qa: last verdict FIX_REQUIRED/);
  assert.match(missing(run(normal, all), { ...low, errorHandling: true }, "t1").items.join(), /nemo-failures: no verdict/);

  const floor = missing(run([], [pass("nemo-quality")]), { floor: "CRITICAL", reasons: ["security-sensitive paths"], errorHandling: false }, "t1");
  assert.equal(floor.mode, "CRITICAL");
  assert.match(floor.items[0], /risk floor: the diff needs CRITICAL/);
  assert.ok(floor.items.some((i) => i.startsWith("nemo-security")));
});

test("verdicts are found in structured payloads", () => {
  assert.equal(findVerdict({ verdict: "PASS" }), "PASS");
  assert.equal(findVerdict({ data: { result: { verdict: "FIX_REQUIRED" } } }), "FIX_REQUIRED");
  assert.equal(findVerdict({ verdict: "maybe" }), null);
});

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-gate-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q", "-b", "work");
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}

test("the code fingerprint covers untracked files and survives a commit", (t) => {
  const { dir, git } = repo(t);
  const clean = treeOf(dir);
  fs.writeFileSync(path.join(dir, "b.js"), "export const b = 2;\n");
  const changed = treeOf(dir);
  assert.notEqual(changed, clean);
  git("add", "-A");
  git("commit", "-qm", "b");
  assert.equal(treeOf(dir), changed);
  assert.equal(git("status", "--porcelain"), "", "fingerprinting leaves the real index alone");
});

function yieldVerdict(omp, ctx, verdict, isError = false) {
  omp.emit("tool_call", { toolName: "yield", input: { data: { verdict, summary: "x" } } }, ctx);
  return omp.emit("tool_result", { toolName: "yield", isError }, ctx);
}

function fakeOmp() {
  const handlers = {};
  return { pi: { on: (name, fn) => { handlers[name] = fn; } }, emit: (name, event, ctx) => handlers[name]?.(event, ctx) };
}

test("end to end: the stop gate blocks once per code state, receipts close it, push waits for it", async (t) => {
  const { dir } = repo(t);
  const omp = fakeOmp();
  register(omp.pi, { runs: new Map(), impeccable: null });
  const main = { cwd: dir, agent: { kind: "main", name: "main" } };
  const sub = (name) => ({ cwd: dir, agent: { kind: "sub", id: name, name } });

  omp.emit("before_subagent_spawn", { agent: "nemo-implementer" }, main);
  assert.equal(omp.emit("tool_call", { toolName: "write", input: { path: path.join(dir, "a.js") } }, sub("nemo-implementer")), undefined);
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");

  const first = omp.emit("session_stop", {}, main);
  assert.equal(first?.decision, "block");
  assert.match(first.reason, /nemo-final-review: no verdict yet/);
  assert.equal(omp.emit("session_stop", {}, main), undefined, "told once about this code state");
  assert.match(omp.emit("tool_call", { toolName: "bash", input: { command: "git push -u origin work" } }, main)?.reason ?? "", /publication waits/);

  for (const a of ["nemo-architect", "nemo-quality", "nemo-qa", "nemo-final-review"]) yieldVerdict(omp, sub(a), "PASS");
  assert.equal(omp.emit("tool_call", { toolName: "bash", input: { command: "git push -u origin work" } }, main), undefined);

  fs.appendFileSync(path.join(dir, "a.js"), "export const d = 4;\nexport const e = 5;\n");
  assert.match(omp.emit("session_stop", {}, main)?.reason ?? "", /nemo-quality: no verdict yet/, "a passed gate starts a new run");
});

test("subagent sessions share the run with the main session", async (t) => {
  const { dir } = repo(t);
  const main = fakeOmp(), child = fakeOmp();
  register(main.pi, { impeccable: null });
  register(child.pi, { impeccable: null });   // OMP rebinds the factory per subagent; default state must be shared
  main.emit("tool_call", { toolName: "write", input: { path: path.join(dir, "b.js") } }, { cwd: dir, agent: { kind: "main" } });
  fs.writeFileSync(path.join(dir, "b.js"), "export const b = 2;\n");
  yieldVerdict(child, { cwd: dir, agent: { kind: "sub", id: "Q1", name: "nemo-quality" } }, "PASS");
  assert.equal(main.emit("session_stop", {}, { cwd: dir, agent: { kind: "main" } }), undefined);
});

test("task results also deliver receipts", async (t) => {
  const { dir } = repo(t);
  const omp = fakeOmp();
  const runs = new Map();
  register(omp.pi, { runs, impeccable: null });
  const main = { cwd: dir, agent: { kind: "main", name: "main" } };
  await omp.emit("tool_result", { toolName: "task", details: { results: [{ agent: "nemo-quality", structuredOutput: { data: { verdict: "PASS" } } }] } }, main);
  assert.deepEqual([...runs.values()][0].receipts.map((r) => [r.agent, r.verdict]), [["nemo-quality", "PASS"]]);
});

test("ownership is judged relative to the repository, not parent folders", (t) => {
  const { dir } = repo(t);
  const nested = path.join(dir, "tests-home");
  const rel = (p) => path.relative(dir, p);
  assert.ok(!blocked("nemo-implementer", "write", { path: path.join(dir, "src", "a.ts") }, rel));
  assert.ok(blocked("nemo-tester", "write", { path: path.join(nested, "src", "a.ts") }, () => "src/a.ts"));
  assert.ok(!blocked("nemo-implementer", "write", { path: "/Users/me/specs/app/src/a.ts" }, () => "src/a.ts"));
});

test("subagents never publish; git options before push are caught", () => {
  assert.ok(blocked("nemo-implementer", "bash", { command: "git push origin x" }));
  assert.ok(blocked("nemo-tester", "bash", { command: "gh pr create --fill" }));
  for (const c of ["git -C repo push", "git -c a=b push -u origin x", "git --no-pager push"]) assert.match(c, /push/), assert.ok(blocked("nemo-implementer", "bash", { command: c }), c);
  assert.ok(!blocked("nemo-implementer", "bash", { command: "git log --oneline" }));
});

test("risk ignores risky words in tests and docs", () => {
  assert.equal(score(["test/a.test.js"], 3, "", "").floor, "LIGHT");
  assert.equal(score(["README.md"], 3, "", "").errorHandling, false);
});

test("edit inputs listing paths are covered", () => {
  assert.deepEqual(writeTargets("edit", { paths: ["src/a.ts", "src/b.ts"] }), ["src/a.ts", "src/b.ts"]);
});

test("a rejected yield records no verdict; an accepted one does", async (t) => {
  const { dir } = repo(t);
  const omp = fakeOmp();
  const runs = new Map();
  register(omp.pi, { runs, impeccable: null });
  const ctx = { cwd: dir, agent: { kind: "sub", id: "Q", name: "nemo-quality" } };
  await yieldVerdict(omp, ctx, "PASS", true);
  assert.equal([...runs.values()].flatMap((r) => r.receipts).length, 0);
  await yieldVerdict(omp, ctx, "PASS");
  assert.equal([...runs.values()].flatMap((r) => r.receipts).length, 1);
});

test("git failures never block ordinary work and are reported", () => {
  const omp = fakeOmp();
  register(omp.pi, { runs: new Map(), impeccable: null });
  const gone = path.join(os.tmpdir(), `sn-gate-missing-${process.pid}`);
  const ctx = { cwd: gone, agent: { kind: "sub", name: "nemo-implementer" } };
  const out = omp.emit("tool_call", { toolName: "write", input: { path: path.join(gone, "a.js") } }, ctx);
  assert.notEqual(out?.block, true);
});

test("pushes with no run are still checked against the upstream", (t) => {
  const { dir, git } = repo(t);
  git("branch", "base");
  git("branch", "--set-upstream-to=base");
  fs.writeFileSync(path.join(dir, "b.js"), "export const b = 2;\nexport const c = 3;\n");
  git("add", "-A");
  git("commit", "-qm", "unreviewed");
  const omp = fakeOmp();
  register(omp.pi, { runs: new Map(), impeccable: null });
  const out = omp.emit("tool_call", { toolName: "bash", input: { command: "git push" } }, { cwd: dir, agent: { kind: "main" } });
  assert.match(out?.reason ?? "", /publication waits/);
});
