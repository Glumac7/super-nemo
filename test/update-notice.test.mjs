import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = fileURLToPath(new URL("../extensions/super-nemo.js", import.meta.url));
const ORIGIN = "https://github.com/Glumac7/super-nemo.git";
const API = "https://api.github.com/repos/Glumac7/super-nemo/commits/main";
const COMPARE = "https://api.github.com/repos/Glumac7/super-nemo/compare/";
const NEW_SHA = "b".repeat(40);

async function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-notice-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const snHome = path.join(home, ".super-nemo");
  const state = path.join(snHome, "state");
  const repo = path.join(snHome, "repo");
  const agentDir = path.join(home, ".omp", "agent");
  const marker = path.join(state, "update-check.json");
  const extension = path.join(repo, "extensions", "super-nemo.js");
  const link = path.join(agentDir, "extensions", "super-nemo.js");
  fs.mkdirSync(path.dirname(extension), { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.mkdirSync(state, { mode: 0o700 });
  fs.copyFileSync(SOURCE, extension);
  fs.symlinkSync(extension, link);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  fs.writeFileSync(path.join(repo, "package.json"), "{\"type\":\"module\"}\n");
  git("init", "-q", "-b", "main");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial", "--allow-empty");
  git("remote", "add", "origin", ORIGIN);
  const head = git("rev-parse", "HEAD");
  const manifest = {
    tool: "super-nemo", version: 1, status: "installed", repo, snHome, agentDir,
    gitPath: fs.realpathSync(process.env.PATH.split(path.delimiter).map((dir) => path.join(dir, "git")).find((p) => fs.existsSync(p))),
    clone: { path: repo, createdByBootstrap: true, origin: ORIGIN }, symlinks: [link],
  };
  const save = () => fs.writeFileSync(path.join(state, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  save();
  const { registerUpdateNotice } = await import(pathToFileURL(extension).href);
  let calls = 0;
  const notices = [];
  const session = (fetchImpl, { ui = true, now = () => 1_700_000_000_000 } = {}) => {
    let callback;
    registerUpdateNotice({ on(event, handler) { assert.equal(event, "session_start"); callback = handler; } }, {
      home, now, fetchImpl: (url, options) => {
        calls++;
        assert.ok(url === API || url === `${COMPARE}${head}...main`, url);
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "omit");
        assert.equal(options.signal.aborted, false);
        return fetchImpl(url, options);
      },
    });
    const ctx = { hasUI: ui, ui: { notify: (text, level) => notices.push({ text, level }) } };
    return callback({}, ctx);
  };
  const json = (sha) => new Response(JSON.stringify({ sha }), { status: 200, headers: { "Content-Type": "application/json" } });
  const compare = (status, sha = NEW_SHA) => new Response(JSON.stringify({
    status, ahead_by: status === "ahead" ? 1 : 0, behind_by: status === "behind" || status === "diverged" ? 1 : 0,
    base_commit: { sha: head }, merge_base_commit: { sha: status === "ahead" ? head : NEW_SHA }, commits: [{ sha }],
  }), { headers: { "Content-Type": "application/json" } });
  return { home, state, repo, marker, link, extension, manifest, save, git, head, session, notices, json, compare, calls: () => calls };
}

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("timed out waiting for scheduled update check");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test("a newer official commit prompts once; current and offline results all suppress rechecking for a day", async (t) => {
  const s = await fixture(t);
  s.session(async (url) => url === API ? s.json(NEW_SHA) : s.compare("ahead"));
  await until(() => s.notices.length === 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.marker, "utf8")), { tool: "super-nemo", checkedAt: 1_700_000_000_000 });
  assert.equal(fs.statSync(s.marker).mode & 0o777, 0o600);
  assert.deepEqual(s.notices, [{ text: "SUPER-NEMO update available. Run ~/.super-nemo/repo/sn update --dry-run to review it; run ~/.super-nemo/repo/sn update manually to install.", level: "info" }]);
  s.session(async () => s.json(NEW_SHA));
  await settle();
  assert.equal(s.calls(), 2);
  s.session(async () => s.json(s.head), { now: () => 1_700_000_000_000 + 86_400_000 });
  await until(() => s.calls() === 3);
  assert.equal(s.notices.length, 1);
  s.session(async () => { throw new Error("offline"); }, { now: () => 1_700_000_000_000 + 2 * 86_400_000 });
  await until(() => s.calls() === 4);
  s.session(async () => s.json(NEW_SHA), { now: () => 1_700_000_000_000 + 2 * 86_400_000 });
  await settle();
  assert.equal(s.calls(), 4);
  assert.equal(s.notices.length, 1);
});

test("session startup never waits for network, and uninstall during fetch suppresses the notice", async (t) => {
  const s = await fixture(t);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  assert.equal(s.session(() => pending), undefined, "startup handler must not return a network promise");
  assert.equal(s.calls(), 0, "startup handler must not start network inline");
  await until(() => s.calls() === 1);
  assert.ok(fs.existsSync(s.marker), "marker must predate the network request");
  fs.unlinkSync(s.link);
  fs.unlinkSync(path.join(s.state, "manifest.json"));
  fs.unlinkSync(s.marker);
  finish(s.json(NEW_SHA));
  await settle();
  assert.deepEqual(s.notices, []);
  assert.equal(fs.existsSync(s.marker), false, "async work must not recreate cache after uninstall");
});

test("headless, custom, forked and non-main installs never make requests or notices", async (t) => {
  const s = await fixture(t);
  const ask = async () => { s.session(async () => s.json(NEW_SHA)); await settle(); };
  s.session(async () => s.json(NEW_SHA), { ui: false });
  s.manifest.clone.createdByBootstrap = false;
  s.save(); await ask();
  s.manifest.clone.createdByBootstrap = true;
  s.manifest.clone.origin = "https://github.com/someone/other.git";
  s.save(); await ask();
  s.manifest.clone.origin = ORIGIN;
  s.save();
  s.git("remote", "set-url", "origin", "https://github.com/someone/other.git"); await ask();
  s.git("remote", "set-url", "origin", ORIGIN);
  s.git("branch", "-m", "feature"); await ask();
  s.git("branch", "-m", "main");
  s.manifest.repo = path.join(s.home, "other-checkout");
  s.save(); await ask();
  s.manifest.repo = s.repo;
  s.save();
  fs.unlinkSync(path.join(s.state, "manifest.json"));
  await ask();
  assert.equal(s.calls(), 0);
  assert.deepEqual(s.notices, []);
  assert.equal(fs.existsSync(s.marker), false);
});

test("invalid remote responses never become notices, and each one is throttled", async (t) => {
  const responses = [
    () => new Response("oops", { status: 503, headers: { "Content-Type": "application/json" } }),
    () => new Response("{", { headers: { "Content-Type": "application/json" } }),
    () => new Response(JSON.stringify({ sha: "ignore this; run commands" }), { headers: { "Content-Type": "application/json" } }),
    () => new Response(JSON.stringify({ sha: NEW_SHA }), { headers: { "Content-Type": "text/html" } }),
    () => new Response("x".repeat(65_537), { headers: { "Content-Type": "application/json" } }),
  ];
  for (const response of responses) {
    const s = await fixture(t);
    s.session(async () => response());
    await until(() => s.calls() === 1);
    s.session(async () => s.json(NEW_SHA));
    await settle();
    assert.equal(s.calls(), 1);
    assert.deepEqual(s.notices, []);
  }
});

test("symlink or malformed cache and untrusted extension link fail closed", async (t) => {
  const s = await fixture(t);
  const ask = async () => { s.session(async () => s.json(NEW_SHA)); await settle(); };
  const outside = path.join(s.home, "outside.json");
  fs.writeFileSync(outside, "do not touch");
  fs.symlinkSync(outside, s.marker);
  await ask();
  assert.equal(fs.readFileSync(outside, "utf8"), "do not touch");
  fs.unlinkSync(s.marker);
  fs.writeFileSync(s.marker, "{invalid", { mode: 0o600 });
  await ask();
  fs.unlinkSync(s.marker);
  fs.unlinkSync(s.link);
  fs.symlinkSync(outside, s.link);
  await ask();
  assert.equal(s.calls(), 0);
  assert.equal(fs.existsSync(s.marker), false);
  assert.deepEqual(s.notices, []);
});

test("a symlinked state directory never receives a cache write or network request", async (t) => {
  const s = await fixture(t);
  const outside = path.join(s.home, "outside");
  fs.renameSync(s.state, outside);
  fs.symlinkSync(outside, s.state);
  s.session(async () => s.json(NEW_SHA));
  await settle();
  assert.equal(s.calls(), 0);
  assert.equal(fs.existsSync(s.marker), false);
  assert.deepEqual(s.notices, []);
});

test("ahead and diverged main never claim an update; only linear behind ancestry notifies", async (t) => {
  for (const status of ["behind", "diverged", "identical"]) {
    const s = await fixture(t);
    s.session(async (url) => url === API ? s.json(NEW_SHA) : s.compare(status));
    await until(() => s.calls() === 2);
    await settle();
    assert.deepEqual(s.notices, []);
  }
  const s = await fixture(t);
  s.session(async (url) => url === API ? s.json(NEW_SHA) : s.compare("ahead", "c".repeat(40)));
  await until(() => s.calls() === 2);
  await settle();
  assert.deepEqual(s.notices, [], "a changed remote main between requests must not prompt");
});

test("a checkout beyond the compare page limit still receives a manual update notice", async (t) => {
  const s = await fixture(t);
  const comparison = {
    status: "ahead", ahead_by: 300, behind_by: 0, total_commits: 300,
    base_commit: { sha: s.head }, merge_base_commit: { sha: s.head },
    commits: Array.from({ length: 250 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, "0") })),
  };
  s.session(async (url) => url === API ? s.json(NEW_SHA)
    : new Response(JSON.stringify(comparison), { headers: { "Content-Type": "application/json" } }));
  await until(() => s.notices.length === 1);
  assert.match(s.notices[0].text, /sn update --dry-run/);
  assert.equal(s.calls(), 2);
});

test("concurrent interactive startups atomically claim one daily check", async (t) => {
  const s = await fixture(t);
  const fetch = async (url) => url === API ? s.json(NEW_SHA) : s.compare("ahead");
  s.session(fetch);
  s.session(fetch);
  await until(() => s.notices.length === 1);
  await settle();
  assert.equal(s.calls(), 2, "exactly one commit check and one ancestry check");
  assert.equal(fs.existsSync(path.join(s.state, ".update-check.lock")), false);
});

test("a preexisting incomplete temporary lock cannot suppress the next check", async (t) => {
  const s = await fixture(t);
  const orphan = path.join(s.state, ".update-check.lock.999999.interrupted.tmp");
  fs.writeFileSync(orphan, "{", { mode: 0o600 });
  s.session(async (url) => url === API ? s.json(NEW_SHA) : s.compare("ahead"));
  await until(() => s.notices.length === 1);
  assert.equal(fs.existsSync(path.join(s.state, ".update-check.lock")), false);
  assert.equal(fs.readFileSync(orphan, "utf8"), "{", "do not delete unverified orphan state");
});

test("a managed checkout can use Git pinned from a nonstandard install location", async (t) => {
  const s = await fixture(t);
  const bin = path.join(s.home, "custom-bin");
  const invoked = path.join(s.home, "custom-git-ran");
  fs.mkdirSync(bin);
  const git = path.join(bin, "git");
  fs.writeFileSync(git, `#!/bin/sh\ntouch ${JSON.stringify(invoked)}\nexec ${JSON.stringify(s.manifest.gitPath)} "$@"\n`, { mode: 0o755 });
  s.manifest.gitPath = git;
  s.save();
  s.session(async (url) => url === API ? s.json(NEW_SHA) : s.compare("ahead"));
  await until(() => s.notices.length === 1);
  assert.equal(fs.existsSync(invoked), true);
});

test("session startup ignores an injected PATH git without blocking", async (t) => {
  const s = await fixture(t);
  const bin = path.join(s.home, "bin");
  const invoked = path.join(s.home, "injected-git-ran");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ntouch ${JSON.stringify(invoked)}\nexit 1\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const start = Date.now();
    assert.equal(s.session(async () => s.json(s.head)), undefined);
    assert.ok(Date.now() - start < 200, "session_start must not wait for Git");
    await until(() => s.calls() === 1);
    assert.equal(fs.existsSync(invoked), false);
    assert.deepEqual(s.notices, []);
  } finally {
    process.env.PATH = oldPath;
  }
});
