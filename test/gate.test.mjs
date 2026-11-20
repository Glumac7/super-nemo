import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findVerdict, missing, policy, publishDir, publishes, register, repoRoot, subagentPublishes, score, securityNote, treeOf, writeTargets } from "../lib/gate.mjs";

// The gate's git must not see this machine's git settings (push.default, push remotes, ...).
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

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

test("subagent publish detection covers wrapped git push and gh api PR writes", (t) => {
  for (const c of ["sh -c 'git push'", "git -c core.x=1 -C . push", "gh api repos/o/r/pulls -X POST -f title=x", "git -c alias.p=push p", "git send-pack x", "gh api graphql -f q=x"]) assert.ok(subagentPublishes(c), c);
  for (const c of ["git log", "gh api repos/o/r/pulls", "echo push"]) assert.ok(!subagentPublishes(c), c);
  for (const c of ['git commit -am "retry push"', "git log --grep=push", "git stash push"]) assert.ok(!publishes(c), `orchestrator: ${c}`);
  for (const c of ["git send-pack origin x", "git -c alias.p=push p", "gh api repos/o/r/pulls -X GET -X POST -f t=x"]) assert.ok(publishes(c), `orchestrator: ${c}`);
  const base = fs.realpathSync(os.tmpdir());
  assert.equal(publishDir(`git -C ${base} push`, "/"), base);
  assert.equal(publishDir(`cd '${base}' && git push`, "/"), base);
  assert.equal(publishDir("cd r2; git push", "/w/r1"), null, "unclear target");
  assert.equal(publishDir("git --git-dir=x push", "/w/r1"), null);
  assert.equal(publishDir("git -C /w/r1/.git push", "/w/r1"), null, "a push from inside .git is refused");
  assert.equal(publishDir("git push", "/w/r1/.git/hooks"), null);
  assert.equal(publishDir("git -C /tmp -C /usr push", "/tmp"), null, "several -C are ambiguous");
  assert.equal(publishDir("git -C $HOME/x push", "/tmp"), null, "shell expansion is refused");
  for (const c of ["git -C /tm[p] push", "git -C {/tmp,/usr} push", "cd /tmp && git -C /usr push", 'git -C "/tmp"x push']) assert.equal(publishDir(c, "/"), null, c);
  for (const c of ["{ cd /usr; git push; }", "if cd /usr; then git push; fi", "x=1 cd /usr && git push", "env -C /usr git push", 'sh -c "cd /usr && git push"', "bash -c 'git push'", "eval git push"]) assert.equal(publishDir(c, "/tmp"), null, c);
  const spaced = fs.mkdtempSync(path.join(os.tmpdir(), "sn gate "));
  t.after(() => fs.rmSync(spaced, { recursive: true, force: true }));
  assert.equal(publishDir(`cd "${spaced}" && git push`, "/"), spaced, "quoted paths may contain spaces");
  assert.equal(publishDir("git -C /does/not/exist push", "/tmp"), null, "a missing target is refused");
});

test("a second repository is gated at stop and on push", (t) => {
  const r1 = repo(t), r2 = repo(t);
  const omp = fakeOmp();
  register(omp.pi, { runs: new Map(), impeccable: null });
  const main = { cwd: r1.dir, agent: { kind: "main" } };
  omp.emit("tool_call", { toolName: "write", input: { path: path.join(r2.dir, "x.js") } }, main);
  fs.writeFileSync(path.join(r2.dir, "x.js"), "export const x = 1;\nexport const y = 2;\n");
  assert.match(omp.emit("tool_call", { toolName: "bash", input: { command: `git -C ${r2.dir} push` } }, main)?.reason ?? "", /publication waits/);
  assert.match(omp.emit("session_stop", {}, main)?.reason ?? "", new RegExp(path.basename(r2.dir)));
});

test("with no upstream and no origin, every file counts as unreviewed", (t) => {
  const { dir } = repo(t);
  const omp = fakeOmp();
  register(omp.pi, { runs: new Map(), impeccable: null });
  const out = omp.emit("tool_call", { toolName: "bash", input: { command: "git push -u origin work" } }, { cwd: dir, agent: { kind: "main" } });
  assert.match(out?.reason ?? "", /publication waits/);
});

test("a real git failure is reported, never blocks a write, and the stop note comes once", (t) => {
  const { dir } = repo(t);
  const omp = fakeOmp();
  register(omp.pi, { runs: new Map(), impeccable: null });
  const main = { cwd: dir, agent: { kind: "main" } };
  omp.emit("tool_call", { toolName: "write", input: { path: path.join(dir, "a.js") } }, main);   // run exists
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sn-fakegit-"));
  fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho 'fatal: simulated failure' >&2\nexit 2\n", { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  t.after(() => { process.env.PATH = PATH; fs.rmSync(bin, { recursive: true, force: true }); });
  const out = omp.emit("tool_call", { toolName: "write", input: { path: path.join(dir, "b.js") } }, { cwd: dir, agent: { kind: "sub", name: "nemo-implementer" } });
  assert.notEqual(out?.block, true);
  assert.match(out?.additionalContext ?? "", /could not/);
  assert.match(omp.emit("session_stop", {}, main)?.additionalContext ?? "", /could not evaluate/);
  assert.equal(omp.emit("session_stop", {}, main), undefined, "reported once per session");
  assert.match(omp.emit("tool_call", { toolName: "bash", input: { command: "git push" } }, main)?.reason ?? "", /could not evaluate/);
});

test("verdicts reach every touched repository; tester copies and removed worktrees are not gated", (t) => {
  const r1 = repo(t), r2 = repo(t), copy = repo(t);
  const omp = fakeOmp();
  register(omp.pi, { runs: new Map(), impeccable: null });
  const main = { cwd: r1.dir, agent: { kind: "main" } };
  omp.emit("tool_call", { toolName: "write", input: { path: path.join(r2.dir, "x.js") } }, main);
  fs.writeFileSync(path.join(r2.dir, "x.js"), "export const x = 1;\n");
  omp.emit("tool_call", { toolName: "write", input: { path: path.join(copy.dir, "test", "x.test.js") } }, { cwd: r1.dir, agent: { kind: "sub", name: "nemo-tester" } });
  fs.mkdirSync(path.join(copy.dir, "test"));
  fs.writeFileSync(path.join(copy.dir, "test", "x.test.js"), "test\n");
  omp.emit("tool_call", { toolName: "bash", input: { command: "npm install", cwd: copy.dir } }, { cwd: r1.dir, agent: { kind: "sub", name: "nemo-tester" } });
  yieldVerdict(omp, { cwd: r1.dir, agent: { kind: "sub", id: "Q", name: "nemo-quality" } }, "PASS");
  fs.writeFileSync(path.join(copy.dir, "test", "x.test.js"), "test 2\n");   // the copy keeps changing after the review
  assert.equal(omp.emit("tool_call", { toolName: "bash", input: { command: `git -C ${r2.dir} push` } }, main), undefined, "r2 reviewed; copy not gated");
  fs.rmSync(r2.dir, { recursive: true, force: true });
  assert.equal(omp.emit("session_stop", {}, main), undefined, "removed worktree and tester copy are not gated");
});

test("the orchestrator's ordinary git commands are not gated", (t) => {
  const { dir } = repo(t);
  const omp = fakeOmp();
  register(omp.pi, { runs: new Map(), impeccable: null });
  const main = { cwd: dir, agent: { kind: "main" } };
  omp.emit("tool_call", { toolName: "write", input: { path: path.join(dir, "a.js") } }, main);
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 2;\nexport const b = 3;\n");
  assert.notEqual(omp.emit("tool_call", { toolName: "bash", input: { command: 'git commit -am "retry push"' } }, main)?.block, true);
  assert.match(omp.emit("tool_call", { toolName: "bash", input: { command: "cd x; git push" } }, main)?.reason ?? "", /publish with a plain/);
});

test("SUPER-NEMO's own evidence files inside .git are not gated and raise no warning", (t) => {
  const { dir } = repo(t);
  const omp = fakeOmp();
  const runs = new Map();
  register(omp.pi, { runs, impeccable: null });
  const out = omp.emit("tool_call", { toolName: "write", input: { path: path.join(dir, ".git", "super-nemo", "task.md") } }, { cwd: dir, agent: { kind: "main" } });
  assert.equal(out, undefined);
  assert.equal(runs.size, 0);
});

test("a push aimed at a git directory without a work tree is refused", (t) => {
  const { dir } = repo(t);
  const omp = fakeOmp();
  register(omp.pi, { runs: new Map(), impeccable: null });
  const main = { cwd: dir, agent: { kind: "main" } };
  fs.symlinkSync(path.join(dir, ".git"), path.join(dir, "GITDIR"));
  for (const target of [path.join(dir, "GITDIR"), path.join(dir, ".GIT")]) {
    assert.match(omp.emit("tool_call", { toolName: "bash", input: { command: `git -C ${target} push` } }, main)?.reason ?? "", /publish with a plain/, target);
  }
});

test("only plain publish shapes are accepted", () => {
  const base = fs.realpathSync(os.tmpdir());
  for (const c of ["git push", "git push -u origin feature/x", "git -c push.default=current push", `git -C ${base} push origin main`, `cd ${base} && git push`, 'gh pr create --title "Fix the parser" --draft']) {
    assert.notEqual(publishDir(c, base), null, c);
  }
  for (const c of ["git push && rm -rf x", "git push; git push", "git push $(echo origin)", "python -c 'import os; os.system(\"git push\")'", "gh pr create -R other/repo", "gh pr merge https://github.com/o/r/pull/1", "gh pr ready github.com/o/r/pull/2", "gh pr create --repo=o/r", "gh pr create && git push", "gh api repos/o/r/pulls -X POST -f t=x", 'gh pr create --body "$(cat x)"', "gh pr create --body <(cat x)", "gh pr create -Rother/repo", 'gh pr create "-R" o/r', "GH_REPO=o/r gh pr create", "gh pr merge HTTPS://GITHUB.COM/o/r/pull/1", "cd - && git push", "cd repo && git push", "cd -P /tmp && git push", "gh pr merge --squash -sR o/r 1", "gh pr merge -dRfoo/bar 1", "gh pr merge o/r#12", "git push\ngit -C /usr push", "cd /tmp && git push\ncd /usr\ngit push", "gh pr create\ngit -C /usr push", 'gh pr create --body "a\nb"']) {
    assert.equal(publishDir(c, base), null, c);
  }
});

// ---------------------------------------------------------------- worktree sessions and HUMAN_REVIEW_REQUIRED

// The orchestrator runs in a folder that is not a repository and the work happens in a separate repository, or
// (inCheckout) it runs in an unchanged main checkout and the work happens in a git worktree of it.
function worktreeSession(t, runs = new Map(), { inCheckout = false } = {}) {
  let session, wt;
  if (inCheckout) {
    const checkout = repo(t);
    withOrigin(checkout.git);
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-worktree-")));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    wt = { dir: path.join(parent, "a") };
    checkout.git("worktree", "add", "-q", "-b", "feature", wt.dir);
    session = checkout.dir;
  } else {
    session = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-session-")));
    t.after(() => fs.rmSync(session, { recursive: true, force: true }));
    assert.equal(repoRoot(session), null, "the session folder is not a git repository");
    wt = repo(t);
    withOrigin(wt.git);
  }
  const omp = fakeOmp();
  register(omp.pi, { runs, impeccable: null });
  const main = { cwd: session, agent: { kind: "main", name: "main" } };
  const sub = (name, cwd = session) => ({ cwd, agent: { kind: "sub", id: name, name } });
  const spawn = (...names) => { for (const name of names) omp.emit("before_subagent_spawn", { agent: { name } }, main); };
  const write = (ctx, file, content, root = wt.dir) => {
    const p = path.join(root, file);
    assert.notEqual(omp.emit("tool_call", { toolName: "write", input: { path: p } }, ctx)?.block, true, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const review = async (verdict, ...agents) => { for (const a of agents) await yieldVerdict(omp, sub(a), verdict); };
  const sh = (command, cwd = wt.dir) => omp.emit("tool_call", { toolName: "bash", input: { command, cwd } }, main);
  return { session, wt, omp, runs, main, sub, spawn, write, review, sh, stop: () => omp.emit("session_stop", {}, main) };
}
// origin's default branch is <branch> at the current commit: the refs a clone leaves, without a network remote.
function withOrigin(git, branch = "main") {
  git("remote", "add", "origin", "https://example.invalid/r.git");
  git("update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
}

const SPECIALISTS = ["nemo-architect", "nemo-quality", "nemo-qa"];
const CRITICAL_SPECIALISTS = [...SPECIALISTS, "nemo-security", "nemo-performance"];
const SMALL = "export const a = 1;\nexport const b = 2;\n";   // a small code change: LIGHT risk floor
const PUSH = "git push -u origin work";

test("spawns from a session outside any repository count for the worktree it already changes", async (t) => {
  const s = worktreeSession(t);
  s.write(s.main, "src/auth/session.js", "export const ttl = 60;\n");   // security-sensitive path: CRITICAL floor
  const team = ["nemo-implementer-critical", "nemo-tester", ...CRITICAL_SPECIALISTS, "nemo-final-review"];
  s.spawn(...team);
  assert.deepEqual([...s.runs.values()].map((r) => [...r.spawned].sort()), [[...team].sort()]);

  const first = s.stop();
  assert.equal(first?.decision, "block");
  assert.match(first.reason, /\(CRITICAL\):/);
  assert.match(first.reason, /nemo-security: no verdict yet/);
  assert.doesNotMatch(first.reason, /risk floor|used LIGHT/, "the run used CRITICAL");

  await s.review("PASS", ...CRITICAL_SPECIALISTS, "nemo-final-review");
  assert.equal(s.sh(PUSH), undefined, "every required review passed");
});

test("a worktree first changed after the spawns starts with the session's spawns", async (t) => {
  const runs = new Map();
  const s = worktreeSession(t, runs);
  const implementer = fakeOmp();
  register(implementer.pi, { runs, impeccable: null });   // the spawned agent's own session shares the runs
  s.omp.emit("before_subagent_spawn", { agent: "nemo-implementer" }, s.main);
  assert.equal(runs.size, 0, "no repository is touched yet");

  const file = path.join(s.wt.dir, "a.js");
  implementer.emit("tool_call", { toolName: "write", input: { path: file } }, s.sub("nemo-implementer", s.wt.dir));
  fs.writeFileSync(file, SMALL);
  assert.deepEqual([...runs.values()].map((r) => [...r.spawned]), [["nemo-implementer"]]);

  await s.review("PASS", "nemo-quality");
  const reason = s.stop()?.reason ?? "";
  assert.match(reason, /\(NORMAL\):/, "the implementer's spawn raised the mode above the LIGHT floor");
  assert.match(reason, /nemo-final-review: no verdict yet/);
  assert.doesNotMatch(reason, /risk floor/);

  await s.review("PASS", "nemo-architect", "nemo-qa", "nemo-final-review");
  assert.equal(s.sh(PUSH), undefined);
});

test("a run reset after a passing state starts with no spawns or receipts", async (t) => {
  const s = worktreeSession(t);
  s.spawn("nemo-implementer");
  s.write(s.sub("nemo-implementer"), "a.js", SMALL);
  await s.review("PASS", ...SPECIALISTS, "nemo-final-review");
  assert.equal(s.sh(PUSH), undefined);
  const [run] = s.runs.values();
  assert.equal(run.spawned.size, 0, "old spawns do not carry into the next task");
  assert.equal(run.receipts.length, 0, "old verdicts do not carry into the next task");

  s.write(s.main, "a.js", `${SMALL}export const c = 3;\n`);
  const reason = s.stop()?.reason ?? "";
  assert.match(reason, /\(LIGHT\):/);
  assert.match(reason, /nemo-quality: no verdict yet/);
  assert.doesNotMatch(reason, /final-review/);

  s.spawn("nemo-implementer");   // a later spawn still reaches the reset run
  assert.match(s.sh(PUSH)?.reason ?? "", /\(NORMAL\):[\s\S]*nemo-final-review: no verdict yet/);
});

test("a recorded spawn never lowers what the diff's risk requires", async (t) => {
  const s = worktreeSession(t);
  const other = repo(t);
  s.write(s.main, "src/auth/session.js", "export const ttl = 60;\n");
  s.write(s.main, "a.js", SMALL, other.dir);
  s.spawn("explore", "nemo-implementer");
  for (const run of s.runs.values()) assert.deepEqual([...run.spawned], ["nemo-implementer"], run.root);

  await s.review("PASS", ...SPECIALISTS, "nemo-final-review");
  const reason = s.sh(PUSH)?.reason ?? "";
  assert.match(reason, /publication waits/);
  assert.match(reason, /risk floor: the diff needs CRITICAL \(security-sensitive paths\), but the run used NORMAL/);
  assert.match(reason, /nemo-security: no verdict yet/);
  assert.doesNotMatch(reason, new RegExp(path.basename(other.dir)), "the small change elsewhere passed at NORMAL");
});

test("a final HUMAN_REVIEW_REQUIRED counts only for the final review and only on the current code state", () => {
  assert.equal(findVerdict({ data: { verdict: "HUMAN_REVIEW_REQUIRED" } }), "HUMAN_REVIEW_REQUIRED");
  const run = (receipts) => ({ spawned: new Set(["nemo-implementer"]), receipts });
  const low = { floor: "LIGHT", reasons: [], errorHandling: false };
  const r = (agent, verdict, tree = "t1") => ({ agent, verdict, tree });
  const specialists = SPECIALISTS.map((a) => r(a, "PASS", "t0"));
  const human = (tree) => r("nemo-final-review", "HUMAN_REVIEW_REQUIRED", tree);

  assert.deepEqual(missing(run([...specialists, human("t1")]), low, "t1").items, []);
  assert.deepEqual(missing(run([...specialists, r("nemo-final-review", "FIX_REQUIRED", "t0"), human("t1")]), low, "t1").items, []);
  assert.deepEqual(missing(run([...specialists, human("t0")]), low, "t1").items, ["nemo-final-review: HUMAN_REVIEW_REQUIRED was for an earlier code state; review the current one"]);
  assert.deepEqual(missing(run([...specialists, human("t0"), r("nemo-final-review", "FIX_REQUIRED")]), low, "t1").items, ["nemo-final-review: last verdict FIX_REQUIRED"]);
  assert.deepEqual(missing(run([...specialists, r("nemo-qa", "HUMAN_REVIEW_REQUIRED"), human("t1")]), low, "t1").items, ["nemo-qa: last verdict HUMAN_REVIEW_REQUIRED"]);
});

test("end to end: a final HUMAN_REVIEW_REQUIRED on the current code state clears an older FIX_REQUIRED", async (t) => {
  const s = worktreeSession(t);
  s.spawn("nemo-implementer");
  s.write(s.sub("nemo-implementer"), "a.js", SMALL);
  await s.review("PASS", ...SPECIALISTS);
  await s.review("FIX_REQUIRED", "nemo-final-review");
  assert.match(s.sh(PUSH)?.reason ?? "", /nemo-final-review: last verdict FIX_REQUIRED/);

  s.write(s.sub("nemo-implementer"), "a.js", `${SMALL}export const c = 3;\n`);
  await s.review("HUMAN_REVIEW_REQUIRED", "nemo-final-review");
  s.write(s.sub("nemo-implementer"), "a.js", `${SMALL}export const c = 4;\n`);
  assert.match(s.sh(PUSH)?.reason ?? "", /nemo-final-review: HUMAN_REVIEW_REQUIRED was for an earlier code state/);

  await s.review("HUMAN_REVIEW_REQUIRED", "nemo-final-review");
  assert.equal(s.stop(), undefined);
  assert.equal(s.sh(PUSH), undefined);
});

test("end to end: a specialist's HUMAN_REVIEW_REQUIRED is not a PASS and does not limit publication", async (t) => {
  const s = worktreeSession(t);
  s.spawn("nemo-implementer");
  s.write(s.sub("nemo-implementer"), "a.js", SMALL);
  await s.review("PASS", "nemo-architect", "nemo-quality", "nemo-final-review");
  await s.review("HUMAN_REVIEW_REQUIRED", "nemo-qa");
  assert.match(s.stop()?.reason ?? "", /nemo-qa: last verdict HUMAN_REVIEW_REQUIRED/);
  assert.match(s.sh(PUSH)?.reason ?? "", /nemo-qa: last verdict HUMAN_REVIEW_REQUIRED/);

  await s.review("PASS", "nemo-qa");
  assert.equal(s.sh("gh pr create --title x"), undefined, "only the final review limits publication to a draft");
});

const DRAFT_ONLY = /^SUPER-NEMO gate: final review requires human review; open the PR as a draft with --draft as the first argument \(gh pr create --draft --title …\); a human marks it ready and merges\.$/;
const PUSH_REFUSED = /^SUPER-NEMO gate: final review requires human review; push to a feature branch only \(.*\); use a bare branch name or HEAD:refs\/heads\/<branch>; a human merges\.$/;

async function humanReview(t, options) {
  const s = worktreeSession(t, new Map(), options);
  s.spawn("nemo-implementer");
  s.write(s.sub("nemo-implementer"), "a.js", SMALL);
  await s.review("PASS", ...SPECIALISTS);
  await s.review("HUMAN_REVIEW_REQUIRED", "nemo-final-review");
  return s;
}

test("after a final HUMAN_REVIEW_REQUIRED only a push and a draft PR are allowed", async (t) => {
  const s = await humanReview(t);
  for (const c of [PUSH, "gh pr create --draft --title x", "gh pr create -d --fill"]) assert.equal(s.sh(c), undefined, c);
  const refused = ["gh pr create", "gh pr create --title x", "gh pr create --fill", "gh pr create --title -d", "gh pr create --title x -d",
    "gh pr create --draft --draft=false", 'gh pr create -d "-d=false"', "gh pr create -fd", 'gh pr create "--draft"',
    "gh pr ready", "gh pr ready 12", "gh pr merge", "gh pr merge --squash 12"];
  for (const c of refused) {
    const out = s.sh(c);
    assert.equal(out?.block, true, c);
    assert.match(out.reason, DRAFT_ONLY, c);
  }
  assert.equal(s.sh("gh pr create --draft --title x"), undefined, "a refused command changes nothing");
});

test("after a final PASS a ready PR, marking ready, merging and a push to main are allowed", async (t) => {
  const s = worktreeSession(t);
  s.spawn("nemo-implementer");
  s.write(s.sub("nemo-implementer"), "a.js", SMALL);
  await s.review("PASS", ...SPECIALISTS, "nemo-final-review");
  for (const c of ["gh pr create --title x", "gh pr ready", "gh pr merge --squash 12", "git push origin HEAD:main"]) assert.equal(s.sh(c), undefined, c);
});

test("draft-only survives a push followed by a docs edit, and a stop", async (t) => {
  const docs = await humanReview(t);
  assert.equal(docs.sh(PUSH), undefined);
  docs.write(docs.main, "README.md", "# notes\n");
  assert.equal(docs.stop(), undefined, "a docs edit opens no gate");
  assert.match(docs.sh("gh pr merge")?.reason ?? "", DRAFT_ONLY);
  assert.match(docs.sh("gh pr ready")?.reason ?? "", DRAFT_ONLY);
  assert.equal(docs.sh("gh pr create --draft --fill"), undefined);

  const stopped = await humanReview(t);
  assert.equal(stopped.stop(), undefined);
  assert.match(stopped.sh("gh pr merge")?.reason ?? "", DRAFT_ONLY);
});

test("draft-only lasts for the session: no later PASS, reset or reviewed code change lifts it", async (t) => {
  const same = await humanReview(t);
  await same.review("PASS", "nemo-final-review");
  assert.match(same.sh("gh pr ready")?.reason ?? "", DRAFT_ONLY, "a final PASS on the same code state");

  const later = await humanReview(t);
  later.write(later.sub("nemo-implementer"), "a.js", `${SMALL}export const c = 3;\n`);
  await later.review("PASS", ...SPECIALISTS, "nemo-final-review");
  assert.match(later.sh("gh pr ready")?.reason ?? "", DRAFT_ONLY, "a final PASS on a later code state in the same run");

  const s = await humanReview(t);
  assert.equal(s.sh(PUSH), undefined);   // the passing state resets the run
  await s.review("PASS", "nemo-final-review");
  assert.match(s.sh("gh pr ready")?.reason ?? "", DRAFT_ONLY, "after the reset, a final PASS on the same code state");
  s.write(s.main, "a.js", `${SMALL}export const c = 3;\n`);   // a LIGHT change: nemo-quality alone closes its gate
  await s.review("PASS", "nemo-quality");
  assert.match(s.sh("gh pr ready")?.reason ?? "", DRAFT_ONLY, "a closed LIGHT gate");
  s.spawn("nemo-implementer");
  s.write(s.sub("nemo-implementer"), "a.js", `${SMALL}export const c = 4;\n`);
  assert.match(s.sh("gh pr ready")?.reason ?? "", /publication waits/);
  await s.review("PASS", ...SPECIALISTS, "nemo-final-review");
  for (const c of ["gh pr ready", "gh pr create --title x", "gh pr merge --squash 12"]) assert.match(s.sh(c)?.reason ?? "", DRAFT_ONLY, c);
  for (const c of [PUSH, "gh pr create --draft --fill"]) assert.equal(s.sh(c), undefined, c);
});

test("draft-only survives removing the worktree that got HUMAN_REVIEW_REQUIRED", async (t) => {
  const s = await humanReview(t);
  const other = repo(t);
  withOrigin(other.git);
  fs.rmSync(s.wt.dir, { recursive: true, force: true });
  assert.match(s.sh("gh pr ready", other.dir)?.reason ?? "", DRAFT_ONLY);
  assert.match(s.sh("gh pr merge --squash 12", other.dir)?.reason ?? "", DRAFT_ONLY);
  assert.equal(s.sh("gh pr create --draft --fill", other.dir), undefined, "the other repository has no open gate");
});

test("a final HUMAN_REVIEW_REQUIRED limits publication only once a repository has changes", async (t) => {
  const s = worktreeSession(t, new Map(), { inCheckout: true });
  s.spawn("nemo-implementer");   // the main checkout gets a run; nothing has changed yet
  assert.deepEqual([...s.runs.keys()], [s.session]);
  await s.review("HUMAN_REVIEW_REQUIRED", "nemo-final-review");
  for (const c of ["gh pr create --title x", "gh pr ready"]) assert.equal(s.sh(c), undefined, c);

  s.write(s.sub("nemo-implementer"), "a.js", SMALL);   // the worktree of the main checkout changes
  await s.review("PASS", ...SPECIALISTS);
  await s.review("HUMAN_REVIEW_REQUIRED", "nemo-final-review");
  assert.match(s.sh("gh pr ready")?.reason ?? "", DRAFT_ONLY);
  assert.equal(s.sh("git push -u origin HEAD"), undefined, "the worktree's feature branch may be pushed");
});

test("while draft-only, git push may only update a feature branch", async (t) => {
  const s = await humanReview(t);
  const git = s.wt.git;
  git("branch", "feature");   // a bare <src> must name a real local branch
  const refused = (c) => assert.match(s.sh(c)?.reason ?? "", PUSH_REFUSED, c);
  for (const c of ["git push origin HEAD:main", "git push origin HEAD:refs/heads/main", "git push origin main", "git push origin refs/heads/master",
    "git push origin feature HEAD:main", "git push origin +HEAD:feature", "git push --force origin feature", "git push -f origin feature",
    "git push --force-with-lease origin feature", "git push --mirror origin", "git push --all origin", "git push --delete origin feature",
    "git push -d origin feature", "git push --tags origin", "git push origin :feature", "git push origin :", "git -c push.default=matching push"]) refused(c);
  for (const c of ["git push -u origin HEAD:refs/heads/feature", "git push origin feature", "git push origin HEAD", "git push"]) assert.equal(s.sh(c), undefined, c);

  git("config", "branch.work.remote", "origin");
  git("config", "branch.work.merge", "refs/heads/main");
  refused("git push");   // a bare push on a branch tracking main
  git("config", "branch.work.merge", "refs/heads/work");
  assert.equal(s.sh("git push"), undefined, "a bare push on a branch tracking itself");

  git("config", "remote.origin.push", "refs/heads/feature:refs/heads/main");
  for (const c of ["git push", "git push origin feature"]) refused(c);
  git("config", "--unset", "remote.origin.push");
  git("config", "remote.origin.mirror", "true");
  refused("git push origin feature");
  git("config", "--unset", "remote.origin.mirror");

  git("checkout", "-q", "--detach");
  for (const c of ["git push", "git push origin HEAD"]) refused(c);
  git("checkout", "-q", "work");

  git("checkout", "-q", "-b", "feat");
  git("config", "branch.feat.remote", "origin");
  git("config", "branch.feat.merge", "refs/heads/feature-x");
  for (const c of ["git push origin feat", "git push"]) assert.equal(s.sh(c), undefined, `${c}, push.default unset`);
  git("config", "push.default", "simple");
  assert.equal(s.sh("git push origin feat"), undefined, "push.default=simple");
  git("config", "push.default", "upstream");   // a bare <branch> goes to its upstream branch
  git("config", "branch.feat.merge", "refs/heads/main");
  for (const c of ["git push -u origin feat", "git push origin HEAD"]) refused(c);
  git("config", "branch.feat.merge", "refs/heads/feature-x");
  assert.equal(s.sh("git push -u origin feat"), undefined, "push.default=upstream, tracking a feature branch");
  git("config", "--add", "branch.feat.merge", "refs/heads/feature-y");
  refused("git push");   // several upstream branches
  git("config", "--unset-all", "branch.feat.merge");
  git("config", "--unset", "push.default");

  for (const c of ["git push upstream feat", "git push git@github.com:o/r.git feat", "git push . feat:x"]) refused(c);   // only origin
  git("config", "branch.feat.remote", "fork");
  refused("git push");
  git("config", "branch.feat.remote", "origin");
  git("config", "branch.feat.pushRemote", "fork");
  refused("git push");
  git("config", "--unset", "branch.feat.pushRemote");
  git("config", "remote.pushDefault", "fork");
  refused("git push");
  git("config", "--unset", "remote.pushDefault");
  git("config", "--unset", "branch.feat.remote");
  assert.equal(s.sh("git push"), undefined, "a bare push with no remote config goes to origin");

  git("tag", "v1");
  git("branch", "main");
  git("symbolic-ref", "refs/heads/alias", "refs/heads/main");
  for (const c of ["git push origin v1", "git push origin v1:feat", "git push origin HEAD:refs/tags/x", "git push origin HEAD:tags/x",
    "git push origin feat:refs/notes/x", "git push origin alias", "git push origin nope"]) refused(c);
  const sha = git("rev-parse", "HEAD").trim();
  for (const c of ["git push origin feat", "git push origin HEAD:feat", `git push origin ${sha}:refs/heads/feat`]) assert.equal(s.sh(c), undefined, c);
  git("checkout", "-q", "--detach");
  refused("git push origin HEAD");
  assert.equal(s.sh("git push origin HEAD:feat"), undefined, "detached HEAD to a named feature branch");
  git("checkout", "-q", "feat");
  git("config", "push.followTags", "true");   // tags would travel with any push
  for (const c of ["git push origin feat", "git push origin HEAD:feat", "git push"]) refused(c);
  git("config", "--unset", "push.followTags");

  git("branch", "feature-x");
  git("symbolic-ref", "refs/heads/alias", "refs/heads/feature-x");
  refused("git push origin alias");   // a symbolic branch, even to a feature branch
  git("symbolic-ref", "refs/heads/x", "refs/heads/feature-x");
  git("config", "branch.x.merge", "refs/heads/main");
  git("config", "push.default", "upstream");
  refused("git push origin x");
  git("config", "--unset", "branch.x.merge");

  git("config", "branch.feat.merge", "refs/heads/main");
  git("config", "push.default", "tracking");   // the deprecated name of upstream
  refused("git push -u origin feat");
  git("config", "push.default", "simple");   // simple pushes a branch to the same name
  assert.equal(s.sh("git push -u origin feat"), undefined, "push.default=simple, tracking main");
  git("config", "--unset", "push.default");
  git("config", "--unset", "branch.feat.merge");

  for (const value of ["on-demand", "only"]) {
    git("config", "push.recurseSubmodules", value);
    refused("git push origin feat");
  }
  git("config", "push.recurseSubmodules", "check");
  assert.equal(s.sh("git push origin feat"), undefined, "push.recurseSubmodules=check pushes nothing else");
  git("config", "--unset", "push.recurseSubmodules");
  git("config", "submodule.recurse", "true");
  refused("git push origin feat");
  git("config", "--unset", "submodule.recurse");

  git("branch", "topic/foo");   // "feature" is already a branch, so "feature/foo" cannot be one
  git("branch", "2026/11/IT-1/foo");
  for (const c of ["git push origin feat:notes/x", "git push origin HEAD:notes/x", "git push origin HEAD:deploy/prod",
    "git push origin HEAD:2026/11/IT-1/foo", "git push origin feat:remotes/origin/x"]) refused(c);   // a slash outside refs/heads/ or heads/
  for (const c of ["git push origin HEAD:refs/heads/topic/foo", "git push origin HEAD:refs/heads/2026/11/IT-1/foo", "git push origin HEAD:heads/feat",
    "git push origin HEAD:feat", "git push origin topic/foo", "git push -u origin 2026/11/IT-1/foo"]) assert.equal(s.sh(c), undefined, c);
  git("branch", "other");
  for (const c of ["git push origin other:sub:main", "git push origin HEAD:a:feat"]) refused(c);   // more than one ":"
  assert.equal(s.sh("git push origin HEAD:refs/heads/feat"), undefined);

  git("branch", "tag");
  git("update-ref", "refs/tags/HEAD", "HEAD");
  for (const c of ["git push origin tag HEAD", "git push origin tag v1", "git push origin feat tag v1"]) refused(c);   // `tag <name>` pushes a tag
  git("update-ref", "-d", "refs/tags/HEAD");
  git("branch", "-D", "tag");
  git("config", "remotes.origin", "origin fork");   // a remote group named origin pushes to fork too
  refused("git push origin feat");
  git("config", "--unset", "remotes.origin");
  assert.equal(s.sh("git push origin feat"), undefined);
  git("checkout", "-q", "work");

  git("update-ref", "refs/remotes/origin/trunk", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  for (const c of ["git push origin HEAD:trunk", "git push origin refs/heads/trunk", "git push origin main"]) refused(c);
  assert.equal(s.sh("git push origin feature"), undefined);
  git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  refused("git push origin feature");   // origin's default branch is unknown: refused
});
