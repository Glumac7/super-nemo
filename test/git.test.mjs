import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { unpushedWork } from "../lib/git.mjs";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

function repo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-git-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, "work");
  const git = (...args) => {
    const res = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: work, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  fs.mkdirSync(work);
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, ".gitignore"), ".DS_Store\nnode_modules/\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  spawnSync("git", ["init", "-q", "--bare", path.join(root, "origin.git")]);
  git("remote", "add", "origin", path.join(root, "origin.git"));
  git("push", "-q", "-u", "origin", "main");
  return { work, git, write: (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text);
  } };
}

test("installed dependencies and Finder files do not count as local work", (t) => {
  const r = repo(t);
  r.write("node_modules/yaml/dist/index.js", "x\n");
  r.write(".DS_Store", "x");
  r.write("skills/.DS_Store", "x");
  assert.equal(unpushedWork(r.work), null);
});

test("other ignored files, untracked files, stashes and detached HEAD keep the checkout", (t) => {
  const r = repo(t);
  fs.appendFileSync(path.join(r.work, ".gitignore"), "*.log\n");
  r.git("commit", "-qam", "ignore logs");
  r.git("push", "-q");
  r.write("x.log", "notes\n");
  assert.match(unpushedWork(r.work), /ignored files/);
  fs.rmSync(path.join(r.work, "x.log"));
  r.write("draft.md", "x\n");
  assert.match(unpushedWork(r.work), /local changes/);
  r.git("stash", "-q", "-u");
  assert.match(unpushedWork(r.work), /stashed/);
  r.git("stash", "drop", "-q");
  assert.equal(unpushedWork(r.work), null);
  r.git("checkout", "-q", "--detach");
  assert.match(unpushedWork(r.work), /detached/);
});

test("a commit that exists only under another remote branch is still unpushed work", (t) => {
  const r = repo(t);
  r.write("work.md", "x\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "local work");
  r.git("push", "-q", "origin", "HEAD:other");
  assert.ok(r.git("branch", "-r").includes("origin/other"));
  assert.match(unpushedWork(r.work), /branch main has commits that are not on the remote \(origin\/main\)/);
});

test("every local branch needs a remote upstream it does not run ahead of", (t) => {
  const r = repo(t);
  r.git("branch", "feature");
  assert.match(unpushedWork(r.work), /branch feature does not track a remote branch/);
  r.git("branch", "-q", "-u", "main", "feature");
  assert.match(unpushedWork(r.work), /branch feature does not track a remote branch/);
  r.git("push", "-q", "-u", "origin", "feature");
  assert.equal(unpushedWork(r.work), null);
});
