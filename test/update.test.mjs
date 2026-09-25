import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { ANONYMOUS, GH_HINT, GITHUB_URL, PRIVATE_HINT, VIA_GH, githubStyle, remote, sandbox, snapshot } from "./helpers.mjs";

const ANSWERS = ["--yes", "--no-smoke", "--approval", "always-ask", "--advisor", "off", "--fast", "alpha/small"];

async function installed(t) {
  const s = sandbox(t);
  const r = remote(t);
  const res = await s.bootstrap(ANSWERS, { SN_REPO_URL: r.url });
  assert.equal(res.code, 0, res.out);
  s.update = (args = []) => s.run(path.join(s.clone, "sn"), ["update", ...args]);
  return { s, r };
}

const addSkill = (name) => (w) => {
  fs.mkdirSync(path.join(w, "skills", name));
  fs.writeFileSync(path.join(w, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: extra skill for the update test\n---\nbody\n`);
};

test("update fast-forwards, re-applies the recorded answers and reports the change", async (t) => {
  const { s, r } = await installed(t);
  const old = s.git(s.clone, ["rev-parse", "HEAD"]).out.trim();
  const sha = r.commit("add a skill", addSkill("nemo-extra"));
  const res = s.update();
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, new RegExp(`${old.slice(0, 12)}\\.\\.${sha.slice(0, 12)}`));
  assert.match(res.out, /add a skill/);
  assert.match(res.out, /link .*skills\/nemo-extra ->/);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
  assert.equal(fs.readlinkSync(path.join(s.agentDir, "skills", "nemo-extra")), path.join(s.clone, "skills", "nemo-extra"));
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.tools.approvalMode, "always-ask");
  assert.equal(config.modelRoles["nemo-fast"], "alpha/small:low");
  assert.deepEqual(config.task.agentAdvisor, { "nemo-implementer": "off", "nemo-implementer-critical": "off" });
  assert.deepEqual(s.manifest().choices, { impl: "alpha/big:high", fast: "alpha/small:low", advisor: null, advisorCritical: null, review: "beta/sol:high", approval: "always-ask" });
});

test("update when already current says so and writes nothing", async (t) => {
  const { s } = await installed(t);
  const before = withoutRemoteRefs(snapshot(s.home));
  const res = s.update();
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Already up to date/);
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
});

test("an update stopped by drift is finished by update --overwrite-drift, then reports up to date", async (t) => {
  const { s, r } = await installed(t);
  const sha = r.commit("add a skill", addSkill("nemo-extra"));
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approvalMode"], "yolo");
  s.write("config.yml", doc.toString());

  const stopped = s.update();
  assert.equal(stopped.code, 3, stopped.out);
  assert.match(stopped.out, /tools\.approvalMode = "yolo"/);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
  assert.notEqual(s.manifest().installedCommit, sha);

  const forced = s.update(["--overwrite-drift"]);
  assert.equal(forced.code, 0, forced.out);
  assert.match(forced.out, /not applied from this commit yet/);
  assert.equal(fs.readlinkSync(path.join(s.agentDir, "skills", "nemo-extra")), path.join(s.clone, "skills", "nemo-extra"));
  assert.equal(YAML.parse(s.read("config.yml")).tools.approvalMode, "always-ask");
  assert.equal(s.manifest().installedCommit, sha);

  const before = withoutRemoteRefs(snapshot(s.home));
  const again = s.update();
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /Already up to date/);
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
});

test("an installation recorded without a commit is re-applied once by update", async (t) => {
  const { s } = await installed(t);
  const m = s.manifest();
  delete m.installedCommit;
  fs.writeFileSync(s.manifestPath, JSON.stringify(m));
  const res = s.update();
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Re-applying your recorded answers/);
  assert.equal(s.manifest().installedCommit, s.git(s.clone, ["rev-parse", "HEAD"]).out.trim());
  assert.match(s.update().out, /Already up to date/);
});

test("while the applied revision fails verification, update keeps saying so until a fixed revision is applied", async (t) => {
  const { s, r } = await installed(t);
  const skill = (w, frontmatter) => {
    fs.mkdirSync(path.join(w, "skills", "nemo-broken"), { recursive: true });
    fs.writeFileSync(path.join(w, "skills", "nemo-broken", "SKILL.md"), `---\n${frontmatter}\n---\nbody\n`);
  };
  r.commit("add a broken skill", (w) => skill(w, "name: wrong-name"));
  const first = s.update();
  assert.notEqual(first.code, 0, first.out);
  assert.match(first.out, /skills\/nemo-broken\/SKILL\.md frontmatter needs name: nemo-broken/);

  const before = withoutRemoteRefs(snapshot(s.home));
  const second = s.update();
  assert.equal(second.code, 1, second.out);
  assert.match(second.out, /update applied but verification fails:\n.*nemo-broken[\s\S]*fix and run `sn update` again/);
  assert.doesNotMatch(second.out, /Already up to date/);
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);

  r.commit("fix the skill", (w) => skill(w, "name: nemo-broken\ndescription: now valid"));
  const fixed = s.update();
  assert.equal(fixed.code, 0, fixed.out);
  const last = s.update();
  assert.equal(last.code, 0, last.out);
  assert.match(last.out, /Already up to date/);
});

test("update refuses a dirty clone or a diverged branch and changes nothing", async (t) => {
  const { s, r } = await installed(t);
  r.commit("upstream", (w) => fs.writeFileSync(path.join(w, "CHANGELOG.txt"), "upstream\n"));
  fs.appendFileSync(path.join(s.clone, "README.md"), "local edit\n");
  const dirty = snapshot(s.home);
  const res = s.update();
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /Update refused, nothing was changed: .* has local changes/);
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), withoutRemoteRefs(dirty));

  assert.equal(s.git(s.clone, ["commit", "-qam", "local work"]).code, 0);
  const diverged = snapshot(s.home);
  const res2 = s.update();
  assert.equal(res2.code, 1, res2.out);
  assert.match(res2.out, /has commits that are not on origin\/main, so it cannot be fast-forwarded/);
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), withoutRemoteRefs(diverged));
});

test("update removes the link of a skill the new revision no longer ships, and uninstall leaves nothing", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  r.commit("add a skill", addSkill("nemo-extra"));
  const before = snapshot(s.home);
  assert.equal((await s.bootstrap(["--yes", "--no-smoke"], { SN_REPO_URL: r.url })).code, 0);
  const link = path.join(s.agentDir, "skills", "nemo-extra");
  assert.ok(fs.lstatSync(link).isSymbolicLink());

  r.commit("drop the skill", (w) => fs.rmSync(path.join(w, "skills", "nemo-extra"), { recursive: true }));
  const res = s.run(path.join(s.clone, "sn"), ["update"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /unlink .*skills\/nemo-extra \(no longer shipped\)/);
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.ok(!s.manifest().symlinks.includes(link));

  const un = s.run(path.join(s.clone, "sn"), ["uninstall"]);
  assert.equal(un.code, 0, un.out);
  assert.deepEqual(snapshot(s.home), before);
});

test("a no-longer-shipped link that points somewhere else stays recorded until it can be removed safely", async (t) => {
  for (const reconcile of [["install", "--reuse", "--no-smoke"], ["uninstall"]]) {
    const s = sandbox(t);
    const r = remote(t);
    r.commit("add a skill", addSkill("nemo-extra"));
    assert.equal((await s.bootstrap(["--yes", "--no-smoke"], { SN_REPO_URL: r.url })).code, 0);
    const link = path.join(s.agentDir, "skills", "nemo-extra");
    const mine = path.join(s.home, "my-skill");
    fs.mkdirSync(mine);
    fs.unlinkSync(link);
    fs.symlinkSync(mine, link);
    r.commit("drop the skill", (w) => fs.rmSync(path.join(w, "skills", "nemo-extra"), { recursive: true }));
    const res = s.run(path.join(s.clone, "sn"), ["update"]);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /left .*skills\/nemo-extra: no longer shipped/);
    assert.equal(fs.readlinkSync(link), mine);
    assert.ok(s.manifest().symlinks.includes(link));

    fs.unlinkSync(link);
    fs.symlinkSync(path.join(s.clone, "skills", "nemo-extra"), link);
    const again = s.run(path.join(s.clone, "sn"), reconcile);
    assert.equal(again.code, 0, again.out);
    assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined, reconcile[0]);
    if (reconcile[0] === "install") assert.ok(!s.manifest().symlinks.includes(link));
  }
});

test("update of a bootstrap clone refuses an origin or upstream remote other than the recorded one", async (t) => {
  const { s, r } = await installed(t);
  r.commit("upstream", (w) => fs.writeFileSync(path.join(w, "CHANGELOG.txt"), "x\n"));
  const other = remote(t);
  assert.equal(s.git(s.clone, ["remote", "add", "mirror", other.url]).code, 0);
  assert.equal(s.git(s.clone, ["fetch", "-q", "mirror", "+refs/heads/main:refs/remotes/mirror/main"]).code, 0);
  assert.equal(s.git(s.clone, ["branch", "-q", "-u", "mirror/main"]).code, 0);
  const head = s.git(s.clone, ["rev-parse", "HEAD"]).out;
  const res = s.update();
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /Update refused, nothing was changed: branch main tracks mirror, not origin/);

  assert.equal(s.git(s.clone, ["branch", "-q", "-u", "origin/main"]).code, 0);
  assert.equal(s.git(s.clone, ["remote", "set-url", "origin", other.url]).code, 0);
  const res2 = s.update();
  assert.equal(res2.code, 1, res2.out);
  assert.match(res2.out, /origin is .* but SUPER-NEMO was installed from/);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out, head);
});

test("a failed fetch reports the remote without the credentials in its URL", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const checkout = path.join(s.home, "src", "super-nemo");
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  assert.equal(s.git(path.dirname(checkout), ["clone", "-q", r.url, "super-nemo"]).code, 0);
  assert.equal(s.run(path.join(checkout, "sn"), ["install", "--yes", "--no-smoke"]).code, 0);
  assert.equal(s.git(checkout, ["remote", "set-url", "origin", "https://someone:s3cr3t-token@127.0.0.1:1/super-nemo.git"]).code, 0);
  const res = s.run(path.join(checkout, "sn"), ["update"]);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /git fetch origin \(https:\/\/\*\*\*@127\.0\.0\.1:1\/super-nemo\.git\) failed/);
  assert.doesNotMatch(res.out, /s3cr3t|someone/);
});

test("update picks credentials from the URL git really fetches, so an alias rewritten to github uses gh or stays anonymous", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const checkout = path.join(s.home, "src", "super-nemo");
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  assert.equal(s.git(path.dirname(checkout), ["clone", "-q", r.url, "super-nemo"]).code, 0);
  assert.equal(s.run(path.join(checkout, "sn"), ["install", "--yes", "--no-smoke"]).code, 0);
  assert.equal(s.git(checkout, ["remote", "set-url", "origin", "sn-alias:super-nemo"]).code, 0);
  const alias = `[url "${GITHUB_URL}"]\n\tinsteadOf = sn-alias:super-nemo\n`;
  for (const [state, config, hint] of [["logged-in", VIA_GH, PRIVATE_HINT], ["absent", ANONYMOUS, `${PRIVATE_HINT}; ${GH_HINT}`]]) {
    const gh = githubStyle(t, s, r.url, { gh: state, gitconfig: alias });
    const res = s.run(path.join(checkout, "sn"), ["update"], gh.env);
    assert.equal(res.code, 1, `${state}: ${res.out}`);
    assert.ok(res.out.includes(`git fetch origin (${GITHUB_URL}) failed`), `${state}: ${res.out}`);
    assert.ok(res.out.includes(`\n${hint}`), `${state}: ${res.out}`);
    if (state === "logged-in") assert.ok(!res.out.includes(GH_HINT), res.out);
    const calls = gh.network();
    assert.deepEqual(calls.map((c) => [c.command, c.config]), [["fetch", config]], state);
    assert.equal(calls[0].prompt, "0", state);
    assert.match(calls[0].gitAskpass, /\/true$/, state);
    assert.equal(calls[0].sshAskpass, "unset", state);
    assert.deepEqual(gh.askpassCalls(), [], state);
    assert.deepEqual(gh.credentialCalls(), [], state);
  }
});

test("update --dry-run lists the new commits and changes nothing else", async (t) => {
  const { s, r } = await installed(t);
  const head = s.git(s.clone, ["rev-parse", "HEAD"]).out;
  r.commit("pending change", (w) => fs.writeFileSync(path.join(w, "CHANGELOG.txt"), "x\n"));
  const before = withoutRemoteRefs(snapshot(s.home));
  const res = s.update(["--dry-run"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Would update .*\n.*pending change/);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out, head);
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
});

test("install --reuse without an installation exits 2", (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const res = s.sn(["install", "--reuse", "--no-smoke"]);
  assert.equal(res.code, 2, res.out);
  assert.match(res.out, /--reuse needs an existing installation/);
  assert.deepEqual(snapshot(s.home), before);
});

function withoutRemoteRefs(snap) {
  return Object.fromEntries(Object.entries(snap).filter(([k]) => !/^\.super-nemo\/repo\/\.git\/(objects|refs\/remotes|logs\/refs\/remotes|shallow|packed-refs)/.test(k)));
}
