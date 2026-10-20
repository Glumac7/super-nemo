import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { ANONYMOUS, GH_HINT, GITHUB_URL, PRIVATE_HINT, VIA_GH, githubStyle, remote, sandbox, snapshot, underPty } from "./helpers.mjs";

const ANSWERS = ["--yes", "--no-smoke", "--name", "jake", "--approval", "always-ask", "--eval-approval", "prompt", "--advisor", "off", "--fast", "alpha/small"];

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
  const res = s.update(["--verbose"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, new RegExp(`Updating SUPER-NEMO: ${old.slice(0, 12)}\\.\\.${sha.slice(0, 12)} \\(1 commit\\)\\n  - add a skill\\n`));
  assert.match(res.out, /- add 1 skill to OMP/);
  assert.match(res.out, /link .*skills\/nemo-extra ->/);
  assert.match(res.out, /OK Linked agents, skills and extensions\n/);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
  assert.equal(fs.readlinkSync(path.join(s.agentDir, "skills", "nemo-extra")), path.join(s.clone, "skills", "nemo-extra"));
  assert.equal(fs.readlinkSync(path.join(s.agentDir, "extensions", "super-nemo.js")), path.join(s.clone, "extensions", "super-nemo.js"));
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.tools.approvalMode, "always-ask");
  assert.equal(config.tools.approval.eval, "prompt");
  assert.equal(config.modelRoles["nemo-fast"], "alpha/small:low");
  assert.deepEqual(config.task.agentAdvisor, { "nemo-implementer": "off", "nemo-implementer-critical": "off" });
  assert.match(s.read("AGENTS.md"), /called SUPER-JAKE/);
  assert.deepEqual(s.manifest().choices, { name: "jake", impl: "alpha/big:high", fast: "alpha/small:low", advisor: null, advisorCritical: null, review: "beta/sol:high", approval: "always-ask", evalApproval: "prompt" });
});

test("update retains legacy manifest-owned eval prompt without recorded consent", async (t) => {
  const { s, r } = await installed(t);
  const legacy = s.manifest();
  delete legacy.choices.evalApproval;
  assert.equal(legacy.config.keys["tools.approval.eval"].ours, "prompt");
  fs.writeFileSync(s.manifestPath, JSON.stringify(legacy));
  r.commit("add a skill", addSkill("nemo-extra"));
  const updated = s.update();
  assert.equal(updated.code, 0, updated.out);
  assert.equal(s.manifest().choices.evalApproval, "prompt");
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
});

test("update when already current says so and writes nothing", async (t) => {
  const { s } = await installed(t);
  const before = withoutRemoteRefs(snapshot(s.home));
  const res = s.update();
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Already up to date/);
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
});

test("current-revision TTY update defaults to keeping removed and edited settings without setup questions", async (t) => {
  const { s } = await installed(t);
  const sha = s.git(s.clone, ["rev-parse", "HEAD"]).out.trim();
  assert.equal(s.manifest().installedCommit, sha);
  const choices = s.manifest().choices;
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.deleteIn(["modelRoles", "default"]);
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const before = s.read("config.yml");

  const result = await underPty(`${JSON.stringify(path.join(s.clone, "sn"))} update`,
    { ...s.env, NO_COLOR: "1" }, () => "");
  assert.equal(result.code, 0, result.out);
  assert.equal(result.questions.length, 1, result.questions.join("\n"));
  assert.match(result.questions[0], /Keep all these changed settings\?/);
  assert.doesNotMatch(result.out, /What should it be called|Use this setup|Run eval code without asking|Run a quick live test|Apply\?/);
  assert.match(result.out, /Main model:.*kept it/);
  assert.match(result.out, /Eval approval:.*kept it/);
  assert.equal(s.read("config.yml"), before);
  assert.deepEqual(s.manifest().choices, choices);
  assert.equal(s.manifest().installedCommit, sha);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
  assert.equal(Object.hasOwn(s.manifest().config.keys, "modelRoles.default"), false);
  assert.equal(Object.hasOwn(s.manifest().config.keys, "tools.approval.eval"), false);
});

test("current-revision drift requires an explicit decision without a terminal or with --yes", async (t) => {
  const { s } = await installed(t);
  const sha = s.git(s.clone, ["rev-parse", "HEAD"]).out.trim();
  assert.equal(s.manifest().installedCommit, sha);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.deleteIn(["modelRoles", "default"]);
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const before = withoutRemoteRefs(snapshot(s.home));

  for (const args of [[], ["--yes"]]) {
    const result = s.update(args);
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /--keep-settings/);
    assert.match(result.out, /--overwrite-drift/);
    assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
  }
  const result = await underPty(`${JSON.stringify(path.join(s.clone, "sn"))} update --yes`,
    { ...s.env, NO_COLOR: "1" }, () => "");
  assert.equal(result.code, 3, result.out);
  assert.equal(result.questions.length, 0, result.questions.join("\n"));
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
});

test("current-revision explicit keep and overwrite resolve drift without a new upstream commit", async (t) => {
  for (const flags of [["--keep-settings"], ["--yes", "--keep-settings"], ["--overwrite-drift"], ["--yes", "--overwrite-drift"]]) {
    await t.test(flags.join(" "), async (t) => {
      const { s } = await installed(t);
      const sha = s.git(s.clone, ["rev-parse", "HEAD"]).out.trim();
      assert.equal(s.manifest().installedCommit, sha);
      const choices = s.manifest().choices;
      const doc = YAML.parseDocument(s.read("config.yml"));
      doc.deleteIn(["modelRoles", "default"]);
      doc.setIn(["tools", "approval", "eval"], "deny");
      s.write("config.yml", doc.toString());
      const before = s.read("config.yml");

      const result = s.update(flags);
      assert.equal(result.code, 0, result.out);
      if (flags.includes("--keep-settings")) {
        assert.equal(s.read("config.yml"), before);
        assert.match(result.out, /Main model:.*kept it/);
        assert.match(result.out, /Eval approval:.*kept it/);
        assert.equal(Object.hasOwn(s.manifest().config.keys, "modelRoles.default"), false);
        assert.equal(Object.hasOwn(s.manifest().config.keys, "tools.approval.eval"), false);
      } else {
        const config = YAML.parse(s.read("config.yml"));
        assert.equal(config.modelRoles.default, choices.impl);
        assert.equal(config.tools.approval.eval, choices.evalApproval);
      }
      assert.deepEqual(s.manifest().choices, choices);
      assert.equal(s.manifest().installedCommit, sha);
      assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
      const resolved = withoutRemoteRefs(snapshot(s.home));
      const again = s.update();
      if (flags.includes("--keep-settings")) {
        assert.equal(again.code, 3, again.out);
        assert.match(again.out, /--keep-settings/);
      } else {
        assert.equal(again.code, 0, again.out);
        assert.match(again.out, /Already up to date/);
      }
      assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), resolved);
    });
  }
});

test("current-revision dry-run and pull-only bypass unresolved drift without writing", async (t) => {
  const { s } = await installed(t);
  assert.equal(s.manifest().installedCommit, s.git(s.clone, ["rev-parse", "HEAD"]).out.trim());
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.deleteIn(["modelRoles", "default"]);
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const before = withoutRemoteRefs(snapshot(s.home));

  for (const flag of ["--dry-run", "--pull-only"]) {
    const result = await underPty(`${JSON.stringify(path.join(s.clone, "sn"))} update ${flag}`,
      { ...s.env, NO_COLOR: "1" }, () => "");
    assert.equal(result.code, 0, result.out);
    assert.equal(result.questions.length, 0, result.questions.join("\n"));
    assert.doesNotMatch(result.out, /Re-applying your recorded answers/);
    assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
  }
  const unresolved = s.update();
  assert.equal(unresolved.code, 3, unresolved.out);
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
});

test("current-revision drift decisions do not suppress broken-skill verification failures", async (t) => {
  for (const flag of ["--keep-settings", "--overwrite-drift"]) {
    await t.test(flag, async (t) => {
      const { s, r } = await installed(t);
      const sha = r.commit("add a broken skill", (w) => {
        fs.mkdirSync(path.join(w, "skills", "nemo-broken"));
        fs.writeFileSync(path.join(w, "skills", "nemo-broken", "SKILL.md"), "---\nname: wrong-name\n---\nbody\n");
      });
      const first = s.update();
      assert.equal(first.code, 1, first.out);
      assert.match(first.out, /skills\/nemo-broken\/SKILL\.md frontmatter needs name: nemo-broken/);
      assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
      assert.equal(s.manifest().installedCommit, sha);
      const doc = YAML.parseDocument(s.read("config.yml"));
      doc.deleteIn(["modelRoles", "default"]);
      doc.setIn(["tools", "approval", "eval"], "deny");
      s.write("config.yml", doc.toString());
      const before = s.read("config.yml");

      const result = s.update([flag]);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /skills\/nemo-broken\/SKILL\.md frontmatter needs name: nemo-broken/);
      assert.doesNotMatch(result.out, /Already up to date/);
      assert.equal(s.manifest().installedCommit, sha);
      if (flag === "--keep-settings") {
        assert.equal(s.read("config.yml"), before);
      } else {
        const config = YAML.parse(s.read("config.yml"));
        assert.equal(config.modelRoles.default, "alpha/big:high");
        assert.equal(config.tools.approval.eval, "prompt");
      }
    });
  }
});

test("current-revision overwrite restores settings relinquished by an earlier keep decision", async (t) => {
  const { s } = await installed(t);
  const sha = s.git(s.clone, ["rev-parse", "HEAD"]).out.trim();
  assert.equal(s.manifest().installedCommit, sha);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.deleteIn(["modelRoles", "default"]);
  doc.setIn(["tools", "approvalMode"], "yolo");
  s.write("config.yml", doc.toString());
  const before = s.read("config.yml");

  const kept = s.update(["--keep-settings"]);
  assert.equal(kept.code, 0, kept.out);
  assert.equal(s.read("config.yml"), before);
  assert.equal(Object.hasOwn(s.manifest().config.keys, "modelRoles.default"), false);
  assert.equal(Object.hasOwn(s.manifest().config.keys, "tools.approvalMode"), false);
  assert.equal(s.manifest().installedCommit, sha);

  const overwritten = s.update(["--overwrite-drift"]);
  assert.equal(overwritten.code, 0, overwritten.out);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.modelRoles.default, "alpha/big:high");
  assert.equal(config.tools.approvalMode, "always-ask");
  assert.equal(config.tools.approval.eval, "prompt");
  assert.equal(s.manifest().config.keys["modelRoles.default"].ours, "alpha/big:high");
  assert.equal(s.manifest().config.keys["tools.approvalMode"].ours, "always-ask");
  assert.equal(s.manifest().installedCommit, sha);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
});

test("current-revision overwrite cannot adopt eval deny relinquished by keep without explicit consent", async (t) => {
  const { s } = await installed(t);
  const sha = s.git(s.clone, ["rev-parse", "HEAD"]).out.trim();
  assert.equal(s.manifest().installedCommit, sha);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.deleteIn(["modelRoles", "default"]);
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const kept = s.update(["--keep-settings"]);
  assert.equal(kept.code, 0, kept.out);
  assert.equal(Object.hasOwn(s.manifest().config.keys, "tools.approval.eval"), false);
  const before = withoutRemoteRefs(snapshot(s.home));

  for (const args of [["--overwrite-drift"], ["--yes", "--overwrite-drift"]]) {
    const result = s.update(args);
    assert.equal(result.code, 3, result.out);
    assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
    assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
    assert.equal(Object.hasOwn(s.manifest().config.keys, "tools.approval.eval"), false);
  }
});

test("an update stopped by drift is finished by update --overwrite-drift, then reports up to date", async (t) => {
  const { s, r } = await installed(t);
  const sha = r.commit("add a skill", addSkill("nemo-extra"));
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approvalMode"], "yolo");
  s.write("config.yml", doc.toString());

  const stopped = s.update();
  assert.equal(stopped.code, 3, stopped.out);
  assert.match(stopped.out, /! Auto-approve: you changed this to on \(config\.yml: tools\.approvalMode\)/);
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

test("update retires an extension omitted by a newer checkout without leaving a broken link", async (t) => {
  const s = sandbox(t);
  const r = remote(t);
  const before = snapshot(s.home);
  const installed = await s.bootstrap(["--yes", "--no-smoke"], { SN_REPO_URL: r.url });
  assert.equal(installed.code, 0, installed.out);
  const link = path.join(s.agentDir, "extensions", "super-nemo.js");
  assert.equal(fs.readlinkSync(link), path.join(s.clone, "extensions", "super-nemo.js"));
  r.commit("retire extension", (w) => fs.unlinkSync(path.join(w, "extensions", "super-nemo.js")));
  const up = s.run(path.join(s.clone, "sn"), ["update"]);
  assert.equal(up.code, 0, up.out);
  assert.match(up.out, /remove 1 extension no longer shipped/);
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.ok(!s.manifest().symlinks.includes(link));
  assert.equal(s.run(path.join(s.clone, "sn"), ["verify"]).code, 0);
  assert.equal(s.run(path.join(s.clone, "sn"), ["uninstall"]).code, 0);
  assert.deepEqual(snapshot(s.home), before);
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
  assert.match(res.out, /- remove 1 skill no longer shipped/);
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
  const bin = path.join(s.home, ".local", "bin");
  assert.equal(fs.readlinkSync(path.join(bin, "sn")), path.join(s.clone, "sn"));
  const res = s.run("sn", ["update", "--dry-run"], { PATH: `${bin}${path.delimiter}${s.env.PATH}` });
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

test("TTY update keeps removed and edited settings in one decision without setup or smoke questions", async (t) => {
  const { s, r } = await installed(t);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.deleteIn(["modelRoles", "default"]);
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const before = s.read("config.yml");
  const choices = s.manifest().choices;
  const sha = r.commit("add a skill", addSkill("nemo-extra"));
  const result = await underPty(`${JSON.stringify(path.join(s.clone, "sn"))} update`,
    { ...s.env, NO_COLOR: "1" }, () => "");
  assert.equal(result.code, 0, result.out);
  assert.equal(result.questions.length, 1, result.questions.join("\n"));
  assert.match(result.questions[0], /Keep all these changed settings\?/);
  assert.doesNotMatch(result.out, /What should it be called|Use this setup|Run eval code without asking|Run a quick live test|Apply\?/);
  assert.match(result.out, /Main model:.*kept it/);
  assert.match(result.out, /Eval approval:.*kept it/);
  assert.equal(s.read("config.yml"), before);
  assert.deepEqual(s.manifest().choices, choices);
  assert.equal(s.manifest().installedCommit, sha);
  assert.ok(fs.lstatSync(s.file("skills/nemo-extra")).isSymbolicLink());

  r.commit("add another skill", addSkill("nemo-later"));
  const later = s.update(["--keep-settings"]);
  assert.equal(later.code, 0, later.out);
  assert.equal(s.read("config.yml"), before);
  const reuse = s.run(path.join(s.clone, "sn"), ["install", "--reuse", "--keep-settings", "--no-smoke"]);
  assert.equal(reuse.code, 0, reuse.out);
  assert.equal(s.read("config.yml"), before);
  const removed = s.run(path.join(s.clone, "sn"), ["uninstall"]);
  assert.equal(removed.code, 0, removed.out);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(Object.hasOwn(config.modelRoles ?? {}, "default"), false);
  assert.equal(config.tools.approval.eval, "deny");
  assert.equal(fs.existsSync(s.manifestPath), false);
});

test("non-TTY update refuses missing consent and --keep-settings completes the pending revision", async (t) => {
  const { s, r } = await installed(t);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.deleteIn(["modelRoles", "default"]);
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const before = snapshot(s.agentDir);
  const manifest = fs.readFileSync(s.manifestPath, "utf8");
  const sha = r.commit("add a skill", addSkill("nemo-extra"));
  const refused = s.update(["--yes"]);
  assert.equal(refused.code, 3, refused.out);
  assert.match(refused.out, /--keep-settings/);
  assert.match(refused.out, /--overwrite-drift/);
  assert.deepEqual(snapshot(s.agentDir), before);
  assert.equal(fs.readFileSync(s.manifestPath, "utf8"), manifest);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
  const kept = s.update(["--yes", "--keep-settings"]);
  assert.equal(kept.code, 0, kept.out);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(Object.hasOwn(config.modelRoles, "default"), false);
  assert.equal(config.tools.approval.eval, "deny");
  assert.equal(s.manifest().installedCommit, sha);
  assert.ok(fs.lstatSync(s.file("skills/nemo-extra")).isSymbolicLink());
});

test("update rejects contradictory drift decisions before fetching or changing the checkout", async (t) => {
  const { s, r } = await installed(t);
  r.commit("must not fetch", addSkill("nemo-extra"));
  const before = snapshot(s.home);
  const result = s.update(["--keep-settings", "--overwrite-drift"]);
  assert.equal(result.code, 2, result.out);
  assert.deepEqual(snapshot(s.home), before);
});

test("unattended update overwrite restores recorded values, including owned eval deny", async (t) => {
  const { s, r } = await installed(t);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.deleteIn(["modelRoles", "default"]);
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const sha = r.commit("add a skill", addSkill("nemo-extra"));
  const result = s.update(["--yes", "--overwrite-drift"]);
  assert.equal(result.code, 0, result.out);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.modelRoles.default, "alpha/big:high");
  assert.equal(config.tools.approval.eval, "prompt");
  assert.equal(s.manifest().installedCommit, sha);
});

test("update --keep-settings never adopts legacy unowned eval deny, even across later revisions", async (t) => {
  const { s, r } = await installed(t);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const legacy = s.manifest();
  delete legacy.choices.evalApproval;
  delete legacy.config.keys["tools.approval.eval"];
  fs.writeFileSync(s.manifestPath, JSON.stringify(legacy));
  r.commit("add a skill", addSkill("nemo-extra"));
  const stopped = s.update(["--overwrite-drift"]);
  assert.equal(stopped.code, 3, stopped.out);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
  for (const skill of ["nemo-next", "nemo-last"]) {
    r.commit(`add ${skill}`, addSkill(skill));
    const kept = s.update(["--keep-settings"]);
    assert.equal(kept.code, 0, kept.out);
    assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
    assert.equal(Object.hasOwn(s.manifest().config.keys, "tools.approval.eval"), false);
  }
  assert.equal(s.run(path.join(s.clone, "sn"), ["uninstall"]).code, 0);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
});

test("update dry run with keep preserves drift, install state and checkout", async (t) => {
  const { s, r } = await installed(t);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  r.commit("pending change", addSkill("nemo-extra"));
  const before = withoutRemoteRefs(snapshot(s.home));
  const result = s.update(["--keep-settings", "--dry-run"]);
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(withoutRemoteRefs(snapshot(s.home)), before);
});

test("cancelling update's bulk question leaves config and ownership unchanged and can be retried", async (t) => {
  const { s, r } = await installed(t);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const before = snapshot(s.agentDir);
  const manifest = fs.readFileSync(s.manifestPath, "utf8");
  const sha = r.commit("add a skill", addSkill("nemo-extra"));
  const result = await underPty(`${JSON.stringify(path.join(s.clone, "sn"))} update`,
    { ...s.env, NO_COLOR: "1" }, () => "\x04");
  assert.equal(result.code, 1, result.out);
  assert.equal(result.questions.length, 1, result.questions.join("\n"));
  assert.match(result.questions[0], /Keep all these changed settings\?/);
  assert.deepEqual(snapshot(s.agentDir), before);
  assert.equal(fs.readFileSync(s.manifestPath, "utf8"), manifest);
  assert.equal(s.git(s.clone, ["rev-parse", "HEAD"]).out.trim(), sha);
  const retry = s.update(["--keep-settings"]);
  assert.equal(retry.code, 0, retry.out);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
  assert.equal(s.manifest().installedCommit, sha);
});

test("update forwards --yes and --keep-settings on a terminal without asking drift questions", async (t) => {
  const { s, r } = await installed(t);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  r.commit("add a skill", addSkill("nemo-extra"));
  const before = snapshot(s.agentDir);
  const command = JSON.stringify(path.join(s.clone, "sn"));
  const refused = await underPty(`${command} update --yes`, { ...s.env, NO_COLOR: "1" }, () => "");
  assert.equal(refused.code, 3, refused.out);
  assert.equal(refused.questions.length, 0, refused.questions.join("\n"));
  assert.deepEqual(snapshot(s.agentDir), before);
  const kept = await underPty(`${command} update --keep-settings`, { ...s.env, NO_COLOR: "1" }, () => "");
  assert.equal(kept.code, 0, kept.out);
  assert.equal(kept.questions.length, 0, kept.questions.join("\n"));
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
  assert.ok(fs.lstatSync(s.file("skills/nemo-extra")).isSymbolicLink());
});
