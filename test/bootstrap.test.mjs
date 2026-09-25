import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ANONYMOUS, GH_HINT, GITHUB_URL, INSTALL, PRIVATE_HINT, REPO, VIA_GH, authServer, githubStyle, remote, sandbox, snapshot } from "./helpers.mjs";

const BOOT = ["--yes", "--no-smoke"];

function globalGitConfig(s) {
  return s.run("git", ["config", "--global", "--list"]);
}

const withoutGitDir = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith(".super-nemo/repo/.git/")));

test("bootstrap installs from a private-style remote, re-runs idempotently and uninstall leaves nothing behind", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const gitBefore = globalGitConfig(s);
  const before = snapshot(s.home);

  const res = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /verify: OK/);
  assert.ok(fs.lstatSync(s.clone).isDirectory());
  assert.equal(fs.readlinkSync(path.join(s.snHome, "current")), s.clone);
  assert.equal(fs.readlinkSync(path.join(s.agentDir, "skills", "super-nemo")), path.join(s.clone, "skills", "super-nemo"));
  const m = s.manifest();
  assert.deepEqual(m.clone, { path: s.clone, createdByBootstrap: true, origin: r.url });
  assert.equal(m.createdHome, true);
  const verify = s.run(path.join(s.clone, "sn"), ["verify"]);
  assert.equal(verify.code, 0, verify.out);

  const installed = withoutGitDir(snapshot(s.home));
  const again = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /Already up to date/);
  assert.match(again.out, /Nothing to change/);
  assert.deepEqual(withoutGitDir(snapshot(s.home)), installed);

  const un = s.run(path.join(s.clone, "sn"), ["uninstall"]);
  assert.equal(un.code, 0, un.out);
  assert.ok(!fs.existsSync(s.snHome));
  assert.deepEqual(snapshot(s.home), before);
  assert.deepEqual(globalGitConfig(s), gitBefore);
});

const assertQuiet = (c, config, label) => {
  assert.deepEqual(c.config, config, label);
  assert.equal(c.prompt, "0", label);
  assert.match(c.gitAskpass, /\/true$/, label);
  assert.equal(c.sshAskpass, "unset", label);
};

test("without gh a github URL installs, updates and uninstalls anonymously and never runs a credential helper", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const gh = githubStyle(t, s, r.url);
  const before = snapshot(s.home);
  assert.equal(s.run("bash", ["-c", "command -v gh"], gh.env).code, 1);
  const sn = (args) => s.run(path.join(s.clone, "sn"), args, gh.env);

  const res = await s.bootstrap(BOOT, gh.env);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(s.manifest().clone, { path: s.clone, createdByBootstrap: true, origin: GITHUB_URL });

  const sha = r.commit("upstream change", (w) => fs.writeFileSync(path.join(w, "CHANGELOG.txt"), "new\n"));
  const up = sn(["update"]);
  assert.equal(up.code, 0, up.out);
  assert.match(up.out, /upstream change/);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);

  const un = sn(["uninstall"]);
  assert.equal(un.code, 0, un.out);
  assert.deepEqual(snapshot(s.home), before);

  const [clone, fetch, ...rest] = gh.network();
  assert.deepEqual(rest, []);
  assert.equal(clone.command, "clone");
  assertQuiet(clone, ANONYMOUS, "clone");
  assert.equal(fetch.command, "fetch");
  assert.deepEqual(fetch.config, [], "fetch goes to the rewritten local URL, so it needs no credential settings");
  assert.deepEqual(gh.credentialCalls(), []);
  assert.deepEqual(gh.askpassCalls(), []);
});

test("a github URL is cloned through gh only when gh reports a login, and a failed clone says why", async (t) => {
  for (const [state, config, hint] of [["logged-in", VIA_GH, PRIVATE_HINT], ["logged-out", ANONYMOUS, `${PRIVATE_HINT}; ${GH_HINT}`]]) {
    const s = sandbox(t);
    const r = remote(t);
    const gh = githubStyle(t, s, r.url, { gh: state });
    const before = snapshot(s.home);

    const missing = await s.bootstrap(BOOT, { ...gh.env, SN_REPO: "Glumac7/missing" });
    assert.equal(missing.code, 1, missing.out);
    assert.ok(missing.out.includes(`could not clone https://github.com/Glumac7/missing.git; ${hint}\n`), `${state}: ${missing.out}`);
    assert.deepEqual(snapshot(s.home), before);

    const res = await s.bootstrap(BOOT, gh.env);
    assert.equal(res.code, 0, `${state}: ${res.out}`);

    const calls = gh.network();
    assert.deepEqual(calls.map((c) => c.command), ["clone", "clone"], state);
    for (const c of calls) assertQuiet(c, config, state);
    assert.ok(gh.ghCalls().includes("auth status --hostname github.com"), state);
    assert.ok(!gh.ghCalls().some((c) => c.startsWith("auth token")), state);
    assert.deepEqual(gh.credentialCalls(), [], state);
  }
});

test("a github clone that is asked for a login fails without running an inherited askpass or credential helper", async (t) => {
  for (const [state, config] of [["absent", ANONYMOUS], ["logged-in", VIA_GH]]) {
    const s = sandbox(t);
    const server = await authServer(t);
    const gh = githubStyle(t, s, server.url, { gh: state, protocols: "file:http" });
    const before = snapshot(s.home);
    const res = await s.bootstrap(BOOT, gh.env);
    assert.equal(res.code, 1, `${state}: ${res.out}`);
    assert.match(res.out, /could not clone https:\/\/github\.com\/Glumac7\/super-nemo\.git/, state);
    assert.ok(server.requests().length > 0, state);
    assert.deepEqual(gh.network().map((c) => c.command), ["clone"], state);
    assertQuiet(gh.network()[0], config, state);
    if (state === "logged-in") assert.ok(gh.ghCalls().includes("auth git-credential get"), gh.ghCalls().join("\n"));
    assert.deepEqual(gh.askpassCalls(), [], state);
    assert.deepEqual(gh.credentialCalls(), [], state);
    assert.deepEqual(snapshot(s.home), before);
  }
});

test("bootstrap aborts without changes when ~/.super-nemo/repo is not its own clone", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  fs.mkdirSync(s.clone, { recursive: true });
  fs.writeFileSync(path.join(s.clone, "notes.txt"), "mine\n");
  const before = snapshot(s.home);
  const res = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /repo exists but is not a checkout this installer created/);
  assert.deepEqual(snapshot(s.home), before);
});

test("a checkout the user cloned to ~/.super-nemo/repo and installed by hand is never updated or deleted", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  fs.mkdirSync(s.snHome);
  assert.equal(s.git(s.snHome, ["clone", "-q", r.url, "repo"]).code, 0);
  const own = s.run(path.join(s.clone, "sn"), INSTALL);
  assert.equal(own.code, 0, own.out);
  assert.equal(s.manifest().clone, null);

  r.commit("upstream change", (w) => fs.writeFileSync(path.join(w, "CHANGELOG.txt"), "new\n"));
  const before = snapshot(s.home);
  const res = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /not a checkout this installer created and installed from/);
  assert.deepEqual(snapshot(s.home), before);

  const un = s.run(path.join(s.clone, "sn"), ["uninstall"]);
  assert.equal(un.code, 0, un.out);
  assert.ok(fs.existsSync(path.join(s.clone, "package.json")));
});

test("a forged bootstrap flag on a checkout elsewhere records no clone to delete", (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const checkout = path.join(s.home, "src", "super-nemo");
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  assert.equal(s.git(path.dirname(checkout), ["clone", "-q", r.url, "super-nemo"]).code, 0);
  const res = s.run(path.join(checkout, "sn"), INSTALL, { SN_BOOTSTRAP_CLONE: "1", SN_BOOTSTRAP_CREATED_HOME: "1" });
  assert.equal(res.code, 0, res.out);
  assert.equal(s.manifest().clone, null);
  assert.equal(s.run(path.join(checkout, "sn"), ["uninstall"]).code, 0);
  assert.ok(fs.existsSync(path.join(checkout, "package.json")));
});

test("bootstrap removes its fresh clone and ~/.super-nemo when the install fails before writing state", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const before = snapshot(s.home);
  const noTty = await s.bootstrap(["--no-smoke"], { SN_REPO_URL: r.url });
  assert.equal(noTty.code, 2, noTty.out);
  assert.match(noTty.out, /no terminal for questions; re-run with --yes/);
  assert.match(noTty.out, /removed .*repo again: no installation was recorded/);
  assert.deepEqual(snapshot(s.home), before);

  fs.mkdirSync(s.file("agents"));
  fs.writeFileSync(path.join(s.agentDir, "agents", "nemo-qa.md"), "my own agent\n");
  const withConflict = snapshot(s.home);
  const conflict = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(conflict.code, 1, conflict.out);
  assert.match(conflict.out, /nemo-qa\.md already exists/);
  assert.deepEqual(snapshot(s.home), withConflict);
});

test("a failed clone leaves no partial checkout", async (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const res = await s.bootstrap(BOOT, { SN_REPO_URL: `file://${path.join(s.home, "missing.git")}` });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /could not clone/);
  assert.deepEqual(snapshot(s.home), before);
});

test("clone failures never print credentials from the repository URL", async (t) => {
  const s = sandbox(t);
  const res = await s.bootstrap(BOOT, { SN_REPO_URL: "https://someone:s3cr3t-token@127.0.0.1:1/super-nemo.git" });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /could not clone https:\/\/\*\*\*@127\.0\.0\.1:1\/super-nemo\.git/);
  assert.doesNotMatch(res.out, /s3cr3t|someone/);
  assert.ok(!fs.existsSync(s.snHome));
});

test("cleanup after a failed install leaves a directory that replaced the fresh clone", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const bin = path.join(s.home, "bin");
  const moved = path.join(s.home, "moved-clone");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "omp"), [
    "#!/usr/bin/env bash",
    `marker=${JSON.stringify(path.join(bin, "called"))}`,
    'if [ ! -e "$marker" ]; then : > "$marker"; echo omp/18.3.0; exit 0; fi',
    `mv ${JSON.stringify(s.clone)} ${JSON.stringify(moved)}`,
    `mkdir ${JSON.stringify(s.clone)} && echo mine > ${JSON.stringify(path.join(s.clone, "user.txt"))}`,
    "exit 1",
  ].join("\n"), { mode: 0o755 });
  const res = await s.bootstrap(BOOT, { SN_REPO_URL: r.url, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /left .*repo: it is no longer the directory this installer created/);
  assert.equal(fs.readFileSync(path.join(s.clone, "user.txt"), "utf8"), "mine\n");
});

test("uninstall keeps a bootstrap clone with local changes or local commits and says why", async (t) => {
  for (const [what, change, reason] of [
    ["edit", (s) => fs.appendFileSync(path.join(s.clone, "README.md"), "local edit\n"), /local changes/],
    ["untracked", (s) => fs.writeFileSync(path.join(s.clone, "my-notes.md"), "draft\n"), /local changes/],
    ["commit", (s) => {
      fs.appendFileSync(path.join(s.clone, "README.md"), "local edit\n");
      assert.equal(s.git(s.clone, ["commit", "-qam", "local work"]).code, 0);
    }, /commits that are not on the remote/],
    ["pushed elsewhere", (s) => {
      fs.appendFileSync(path.join(s.clone, "README.md"), "local edit\n");
      assert.equal(s.git(s.clone, ["commit", "-qam", "local work"]).code, 0);
      assert.equal(s.git(s.clone, ["push", "-q", "origin", "HEAD:other"]).code, 0);
      assert.equal(s.git(s.clone, ["fetch", "-q", "origin", "+refs/heads/other:refs/remotes/origin/other"]).code, 0);
    }, /branch main has commits that are not on the remote/],
    ["extra branch", (s) => assert.equal(s.git(s.clone, ["branch", "feature"]).code, 0), /branch feature does not track a remote branch/],
    ["detached", (s) => assert.equal(s.git(s.clone, ["checkout", "-q", "--detach"]).code, 0), /HEAD is detached/],
  ]) {
    const s = sandbox(t);
    const r = remote(t);
    const res = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
    assert.equal(res.code, 0, `${what}: ${res.out}`);
    change(s);
    const dry = s.run(path.join(s.clone, "sn"), ["uninstall", "--dry-run"]);
    assert.match(dry.out, reason, what);
    const un = s.run(path.join(s.clone, "sn"), ["uninstall"]);
    assert.equal(un.code, 0, `${what}: ${un.out}`);
    assert.match(un.out, new RegExp(`kept ${s.clone}: .*${reason.source}`), what);
    assert.ok(fs.existsSync(path.join(s.clone, ".git")), what);
    assert.ok(!fs.existsSync(path.join(s.snHome, "state")), what);
  }
});

test("dry-run uninstall lists the clone removal and changes nothing", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  assert.equal((await s.bootstrap(BOOT, { SN_REPO_URL: r.url })).code, 0);
  const installed = snapshot(s.home);
  const dry = s.run(path.join(s.clone, "sn"), ["uninstall", "--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, new RegExp(`remove ${s.clone} \\(the checkout the bootstrap installer created`));
  assert.deepEqual(snapshot(s.home), installed);
});

function underPty(command, env, answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-pty-"));
  const fifo = path.join(dir, "keys");
  spawnSync("mkfifo", [fifo]);
  const inner = `${command}; echo "SN-PTY-EXIT=$?"`;
  const pty = process.platform === "darwin" ? "script -q /dev/null bash -c \"$0\"" : "script -qec \"$0\" /dev/null";
  const child = spawn("bash", ["-c", `cat "$1" | ${pty} 2>&1 | cat`, inner, fifo], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const keys = fs.createWriteStream(fifo);
  let out = "";
  let cursor = 0;
  let code = null;
  const onData = (d) => {
    out += d;
    for (;;) {
      const m = /Choice \[\d+\]: |\[[yY]\/[nN]\] /.exec(out.slice(cursor));
      if (!m) break;
      const question = out.slice(cursor, cursor + m.index + m[0].length);
      cursor += m.index + m[0].length;
      keys.write(`${answer(question)}\r`);
    }
    const exit = /SN-PTY-EXIT=(\d+)/.exec(out);
    if (exit && code === null) {
      code = Number(exit[1]);
      keys.end();
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return new Promise((resolve) => {
    const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 180_000);
    child.on("close", () => {
      clearTimeout(timer);
      keys.end();
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, out });
    });
  });
}

test("prompts work when the bootstrap script arrives on stdin", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const command = `cat ${JSON.stringify(path.join(REPO, "install.sh"))} | bash -s -- --no-smoke`;
  const answer = (q) => (/Apply this plan/.test(q) ? "y" : /advisor for NORMAL|smoke evals/.test(q) ? "n" : "");
  const { code, out } = await underPty(command, { ...s.env, SN_REPO_URL: r.url }, answer);
  assert.equal(code, 0, out);
  assert.match(out, /Apply this plan\?/);
  assert.match(out, /Installed\./);
  assert.equal(s.manifest().choices.advisor, null);
  assert.equal(s.manifest().choices.approval, "write");
});

test("re-running the one-liner fast-forwards the clone through sn update; a dirty clone stops it", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  assert.equal((await s.bootstrap(BOOT, { SN_REPO_URL: r.url })).code, 0);
  const sha = r.commit("add a skill", (w) => {
    fs.mkdirSync(path.join(w, "skills", "nemo-extra"));
    fs.writeFileSync(path.join(w, "skills", "nemo-extra", "SKILL.md"), "---\nname: nemo-extra\ndescription: extra\n---\nbody\n");
  });
  const res = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Updating .*: [0-9a-f]{12}\.\.[0-9a-f]{12}/);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
  assert.equal(fs.readlinkSync(path.join(s.agentDir, "skills", "nemo-extra")), path.join(s.clone, "skills", "nemo-extra"));

  r.commit("more", (w) => fs.writeFileSync(path.join(w, "CHANGELOG.txt"), "x\n"));
  fs.appendFileSync(path.join(s.clone, "README.md"), "local edit\n");
  const before = snapshot(s.home);
  const dirty = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(dirty.code, 1, dirty.out);
  assert.match(dirty.out, /Update refused, nothing was changed: .* has local changes/);
  assert.deepEqual(snapshot(s.home), before);
});

test("re-running the one-liner after an interrupted first install recovers and keeps the clone owned", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const before = snapshot(s.home);
  assert.equal((await s.bootstrap(BOOT, { SN_REPO_URL: r.url })).code, 0);
  const m = s.manifest();
  const pending = {
    ...m,
    status: "pending",
    txn: {
      backupDir: "backups/x",
      files: Object.entries(m.files).map(([kind, f]) => ({ kind, path: f.path, existed: !f.created, backup: f.backup, backupHash: f.backupHash, afterHash: f.postHash })),
      symlinks: m.symlinks.map((p) => ({ path: p })),
      dirs: m.createdDirs,
      previous: null,
    },
  };
  fs.writeFileSync(s.manifestPath, JSON.stringify(pending));
  const res = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /interrupted install; rolling it back first/);
  const again = s.manifest();
  assert.equal(again.status, "installed");
  assert.deepEqual(again.clone, { path: s.clone, createdByBootstrap: true, origin: r.url });
  assert.equal(again.createdHome, true);
  assert.equal(s.run(path.join(s.clone, "sn"), ["uninstall"]).code, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("a clone that cannot be deleted after the state is gone is named, and exit is non-zero", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  assert.equal((await s.bootstrap(BOOT, { SN_REPO_URL: r.url })).code, 0);
  fs.chmodSync(path.join(s.clone, "skills", "super-nemo"), 0o555);
  const res = s.run(path.join(s.clone, "sn"), ["uninstall"]);
  assert.equal(res.code, 1, res.out);
  const m = /but (\S+) \(the old .*repo\) could not be deleted .* It is safe to delete that directory/.exec(res.out);
  assert.ok(m, res.out);
  assert.ok(fs.existsSync(m[1]));
  assert.ok(!fs.existsSync(s.clone));
  assert.ok(!fs.existsSync(path.join(s.snHome, "state")));
  fs.chmodSync(path.join(m[1], "skills", "super-nemo"), 0o755);
});

test("a fresh one-liner with --dry-run leaves HOME as it was, and a real run afterwards installs", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const before = snapshot(s.home);
  const dry = await s.bootstrap([...BOOT, "--dry-run"], { SN_REPO_URL: r.url });
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /set tools\.approvalMode/);
  assert.match(dry.out, /removed .*repo again: no installation was recorded/);
  assert.deepEqual(snapshot(s.home), before);
  const real = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(real.code, 0, real.out);
  assert.equal(s.manifest().status, "installed");
});

test("the one-liner with --dry-run on an existing clone does not move it or change anything", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  assert.equal((await s.bootstrap(BOOT, { SN_REPO_URL: r.url })).code, 0);
  const head = s.git(s.clone, ["rev-parse", "HEAD"]).out;
  r.commit("pending change", (w) => fs.writeFileSync(path.join(w, "CHANGELOG.txt"), "x\n"));
  const before = withoutGitDir(snapshot(s.home));
  const res = await s.bootstrap([...BOOT, "--dry-run"], { SN_REPO_URL: r.url });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Would update .*\n.*pending change/);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out, head);
  assert.deepEqual(withoutGitDir(snapshot(s.home)), before);
});

test("an install that fails after recovering an interrupted first install removes the adopted clone", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  assert.equal((await s.bootstrap(BOOT, { SN_REPO_URL: r.url })).code, 0);
  const m = s.manifest();
  const pending = {
    ...m,
    status: "pending",
    txn: {
      backupDir: "backups/x",
      files: Object.entries(m.files).map(([kind, f]) => ({ kind, path: f.path, existed: !f.created, backup: f.backup, backupHash: f.backupHash, afterHash: f.postHash })),
      symlinks: m.symlinks.map((p) => ({ path: p })),
      dirs: m.createdDirs,
      previous: null,
    },
  };
  fs.writeFileSync(s.manifestPath, JSON.stringify(pending));
  const userAgent = path.join(s.agentDir, "agents", "nemo-qa.md");
  fs.unlinkSync(userAgent);
  fs.writeFileSync(userAgent, "my own agent\n");
  const res = await s.bootstrap(BOOT, { SN_REPO_URL: r.url });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /interrupted install; rolling it back first/);
  assert.match(res.out, /nemo-qa\.md already exists/);
  assert.match(res.out, /removed .*repo again: no installation was recorded/);
  assert.ok(!fs.existsSync(s.snHome));
  assert.equal(fs.readFileSync(userAgent, "utf8"), "my own agent\n");
});

test("uninstall that cannot remove the state changes nothing and keeps a working clone", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  s.write("AGENTS.md", "# mine\n");
  assert.equal((await s.bootstrap(BOOT, { SN_REPO_URL: r.url })).code, 0);
  const backups = path.join(s.snHome, "state", "backups");
  const ts = path.join(backups, fs.readdirSync(backups)[0]);
  fs.chmodSync(ts, 0o555);
  const before = snapshot(s.home);
  const res = s.run(path.join(s.clone, "sn"), ["uninstall"]);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /Uninstall incomplete, nothing was changed[\s\S]*is not writable/);
  fs.chmodSync(ts, 0o755);
  assert.deepEqual(snapshot(s.home), before);
  assert.equal(s.manifest().status, "installed");
  const st = s.run(path.join(s.clone, "sn"), ["status"]);
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /is installed/);
});

test("a fresh one-liner that only prints help leaves no clone behind", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const before = snapshot(s.home);
  const res = await s.bootstrap(["--help"], { SN_REPO_URL: r.url });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Usage: \.\/sn/);
  assert.deepEqual(snapshot(s.home), before);
});
