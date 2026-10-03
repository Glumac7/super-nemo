import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { INSTALL, REPO, seedUserContent, sandbox, snapshot } from "./helpers.mjs";

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function pendingFrom(m, overrides = {}) {
  return {
    ...m,
    status: "pending",
    txn: {
      backupDir: m.files.agents?.backup ? path.dirname(m.files.agents.backup) : "backups/x",
      files: Object.entries(m.files).map(([kind, f]) => ({
        kind, path: f.path, existed: !f.created, backup: f.backup, backupHash: f.backupHash, afterHash: f.postHash,
      })),
      symlinks: m.symlinks.map((p) => ({ path: p, previous: null })),
      dirs: m.createdDirs,
      previous: null,
      ...overrides,
    },
  };
}

test("invalid eval approval is rejected before recovering a pending install", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  fs.writeFileSync(s.manifestPath, JSON.stringify(pendingFrom(s.manifest())));
  const before = snapshot(s.home);
  const rejected = s.sn(["install", "--yes", "--eval-approval", "deny", "--no-smoke"]);
  assert.equal(rejected.code, 2, rejected.out);
  assert.match(rejected.out, /--eval-approval must be one of allow, prompt/);
  assert.doesNotMatch(rejected.out, /rolling it back/);
  assert.deepEqual(snapshot(s.home), before);
  assert.equal(s.manifest().status, "pending");
});

test("a tampered manifest cannot make uninstall delete paths it does not own", (t) => {
  const s = sandbox(t);
  s.write("AGENTS.md", "# My rules\n");
  assert.equal(s.sn(INSTALL).code, 0);

  const victimDir = path.join(s.home, "victim-dir");
  const victimFile = path.join(s.home, "victim.txt");
  const victimLink = path.join(s.home, "victim-link");
  const userFile = s.file("keybindings.yml");
  fs.mkdirSync(victimDir);
  fs.writeFileSync(victimFile, "");
  fs.symlinkSync(path.join(REPO, "skills", "super-nemo"), victimLink);
  fs.writeFileSync(userFile, "");
  fs.writeFileSync(path.join(s.snHome, "state", "other-file"), "keep me\n");
  const replaced = path.join(s.agentDir, "skills", "super-nemo");
  fs.unlinkSync(replaced);
  fs.mkdirSync(replaced);
  fs.writeFileSync(path.join(replaced, "SKILL.md"), "user copy\n");

  const m = s.manifest();
  m.symlinks.push(victimLink, "/etc");
  m.createdDirs.push(victimDir, s.home, path.join(s.agentDir, "sessions"));
  m.files.agents = { path: s.file("AGENTS.md"), created: true, backup: null, postHash: sha(s.read("AGENTS.md")) };
  m.files.watchdogMd = { ...m.files.watchdogMd, path: victimFile, created: true, postHash: sha("") };
  m.files.bogus = { path: userFile, created: true, backup: null, postHash: sha("") };
  m.files.config.backup = "backups/../../../victim.txt";
  fs.writeFileSync(s.manifestPath, JSON.stringify(m));

  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.ok(fs.existsSync(victimDir));
  assert.ok(fs.existsSync(victimFile));
  assert.equal(fs.readlinkSync(victimLink), path.join(REPO, "skills", "super-nemo"));
  assert.ok(fs.existsSync(userFile));
  assert.equal(s.read("AGENTS.md"), "# My rules\n");
  assert.equal(fs.readFileSync(path.join(replaced, "SKILL.md"), "utf8"), "user copy\n");
  assert.equal(fs.readFileSync(path.join(s.snHome, "state", "other-file"), "utf8"), "keep me\n");
  assert.ok(!fs.existsSync(s.manifestPath));
  assert.match(res.out, /left .*victim-link: not a path this installer manages/);
  assert.match(res.out, /left .*victim-dir: not a directory this installer creates/);
  assert.match(res.out, /ignored manifest entry, file .*keybindings\.yml/);
  assert.match(res.out, /ignored manifest entry, file .*victim\.txt/);
  assert.match(res.out, /left .*skills\/super-nemo: not a symlink into/);
  assert.match(res.out, /left .*state: contains files that are not ours/);
});

test("a manifest that is not ours stops every command without changes", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  fs.writeFileSync(s.manifestPath, JSON.stringify({ tool: "other", files: { x: { path: "/etc/hosts" } } }));
  const before = snapshot(s.home);
  for (const cmd of [["uninstall"], ["status"], INSTALL]) {
    const res = s.sn(cmd);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /is not a SUPER-NEMO manifest/);
  }
  assert.deepEqual(snapshot(s.home), before);
});

test("an existing ~/.super-nemo/state without our manifest aborts install", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.snHome, "state"), { recursive: true });
  fs.writeFileSync(path.join(s.snHome, "state", "notes.txt"), "mine\n");
  fs.mkdirSync(path.join(s.snHome, "standards"));
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 1);
  assert.match(res.out, /state exists but holds no SUPER-NEMO manifest/);
  assert.deepEqual(snapshot(s.home), before);
});

test("user files in an existing ~/.super-nemo survive install and uninstall", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.snHome, "standards"), { recursive: true });
  fs.writeFileSync(path.join(s.snHome, "standards", "ENGINEERING.md"), "old\n");
  const before = snapshot(s.home);
  assert.equal(s.sn(INSTALL).code, 0);
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("malformed super-nemo markers abort without touching the file", (t) => {
  const cases = [
    "intro\n<!-- super-nemo:begin -->\nno end\n",
    "<!-- super-nemo:end -->\n<!-- super-nemo:begin -->\n",
    "<!-- super-nemo:begin -->\na\n<!-- super-nemo:end -->\n<!-- super-nemo:begin -->\nb\n<!-- super-nemo:end -->\n",
  ];
  for (const [i, text] of cases.entries()) {
    const s = sandbox(t);
    s.write(i === 1 ? "WATCHDOG.md" : "AGENTS.md", text);
    const before = snapshot(s.home);
    const res = s.sn(INSTALL);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /malformed super-nemo markers/);
    assert.deepEqual(snapshot(s.home), before);
  }
});

test("an existing well-formed block is replaced in place and restored on uninstall", (t) => {
  const s = sandbox(t);
  s.write("AGENTS.md", "top\n<!-- super-nemo:begin -->\n@~/old/path.md\n<!-- super-nemo:end -->\nbottom\n");
  const original = s.read("AGENTS.md");
  assert.equal(s.sn(INSTALL).code, 0);
  assert.equal(s.read("AGENTS.md"), "top\n<!-- super-nemo:begin -->\n@~/.super-nemo/current/blocks/AGENTS.md\n<!-- super-nemo:end -->\nbottom\n");
  s.write("AGENTS.md", `${s.read("AGENTS.md")}more\n`);
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.equal(s.read("AGENTS.md"), `${original}more\n`);
});

test("a differing SUPER-NEMO advisor in WATCHDOG.yml aborts; an identical one is left alone", (t) => {
  const s = sandbox(t);
  s.write("WATCHDOG.yml", "advisors:\n  - name: SUPER-NEMO\n    tools: [read]\n");
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 1);
  assert.match(res.out, /advisor named SUPER-NEMO already exists and differs/);
  assert.deepEqual(snapshot(s.home), before);

  s.write("WATCHDOG.yml", "advisors:\n  - name: SUPER-NEMO\n    tools: [read, grep, glob]\n");
  const same = s.read("WATCHDOG.yml");
  assert.equal(s.sn(INSTALL).code, 0);
  assert.equal(s.read("WATCHDOG.yml"), same);
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.equal(s.read("WATCHDOG.yml"), same);
});

test("an emptied installer-created bash.patterns key is removed on uninstall", (t) => {
  const s = sandbox(t);
  s.write("config.yml", "theme:\n  dark: midnight\n");
  assert.equal(s.sn(INSTALL).code, 0);
  s.write("config.yml", "theme:\n  dark: midnight\n  light: paper\nbash:\n  patterns: []\n");
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(YAML.parse(s.read("config.yml")), { theme: { dark: "midnight", light: "paper" } });
});

test("a deny rule shadowed by a user allow is inserted at the head and removed again on uninstall", (t) => {
  const s = sandbox(t);
  const userList = [{ match: "*", approval: "allow" }, { match: "*printenv*", approval: "deny" }];
  s.write("config.yml", YAML.stringify({ bash: { patterns: userList } }));
  assert.equal(s.sn(INSTALL).code, 0);
  const patterns = YAML.parse(s.read("config.yml")).bash.patterns;
  const ours = patterns.findIndex((p) => p.match === "*printenv*");
  assert.ok(ours < patterns.findIndex((p) => p.match === "*"));
  assert.equal(patterns.filter((p) => p.match === "*printenv*").length, 2);
  assert.equal(s.manifest().config.patterns.inserted.filter((e) => e.match === "*printenv*").length, 1);
  const verify = s.sn(["verify"]);
  assert.equal(verify.code, 0, verify.out);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.set("theme", "dark");
  s.write("config.yml", doc.toString());
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(YAML.parse(s.read("config.yml")).bash.patterns, userList);
});

test("symlinked mergeable files and symlinked skills dirs are refused", (t) => {
  const s = sandbox(t);
  const dotfiles = path.join(s.home, "dotfiles");
  fs.mkdirSync(path.join(dotfiles, "skills"), { recursive: true });
  fs.writeFileSync(path.join(dotfiles, "AGENTS.md"), "shared\n");
  fs.symlinkSync(path.join(dotfiles, "AGENTS.md"), s.file("AGENTS.md"));
  fs.symlinkSync(path.join(dotfiles, "skills"), s.file("skills"));
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 1);
  assert.match(res.out, /AGENTS\.md is not a regular file/);
  assert.match(res.out, /skills is a symlink or not a directory/);
  assert.deepEqual(snapshot(s.home), before);
});

test("a symlinked extensions parent is refused before writing through it", (t) => {
  const s = sandbox(t);
  const elsewhere = path.join(s.home, "my-extensions");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "super-nemo.js"), "user extension\n");
  fs.symlinkSync(elsewhere, s.file("extensions"));
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /extensions is a symlink or not a directory/);
  assert.deepEqual(snapshot(s.home), before);
});

test("a regular file at the extensions parent is refused before state creation", (t) => {
  const s = sandbox(t);
  s.write("extensions", "not a directory\n");
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /extensions is a symlink or not a directory/);
  assert.deepEqual(snapshot(s.home), before);
});

test("an existing sn command is never claimed or overwritten, even if it points to this repo", (t) => {
  for (const kind of ["file", "matching-link"]) {
    const s = sandbox(t);
    const bin = path.join(s.home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const launcher = path.join(bin, "sn");
    if (kind === "file") fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    else fs.symlinkSync(path.join(REPO, "sn"), launcher);
    const before = snapshot(s.home);
    const res = s.sn(INSTALL);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /bin\/sn already exists.*and is not ours/);
    assert.deepEqual(snapshot(s.home), before);
  }
});

test("a symlinked launcher parent blocks installation before touching external data", (t) => {
  for (const parent of [".local", "bin"]) {
    const s = sandbox(t, { localBin: false });
    const outside = path.join(s.home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sn"), "user command");
    if (parent === "bin") fs.mkdirSync(path.join(s.home, ".local"));
    fs.symlinkSync(outside, parent === "bin" ? path.join(s.home, ".local", "bin") : path.join(s.home, ".local"));
    const before = snapshot(s.home);
    const res = s.sn(INSTALL);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /symlink or not a directory; refusing to install the sn launcher/);
    assert.deepEqual(snapshot(s.home), before);
  }
});

test("uninstall leaves an sn launcher replaced or hidden behind a symlinked parent", (t) => {
  for (const parentSwap of [false, true]) {
    const s = sandbox(t);
    assert.equal(s.sn(INSTALL).code, 0);
    const bin = path.join(s.home, ".local", "bin");
    const launcher = path.join(bin, "sn");
    if (parentSwap) {
      const moved = path.join(s.home, "saved-bin");
      fs.renameSync(bin, moved);
      fs.symlinkSync(moved, bin);
    } else {
      fs.unlinkSync(launcher);
      fs.writeFileSync(launcher, "user command");
    }
    const res = s.sn(["uninstall"]);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /left .*bin\/sn: not a (symlink into|path this installer manages)/);
    if (parentSwap) assert.equal(fs.readlinkSync(path.join(s.home, "saved-bin", "sn")), path.join(REPO, "sn"));
    else assert.equal(fs.readFileSync(launcher, "utf8"), "user command");
  }
});

test("status and uninstall do not claim a same-target launcher replaced after install", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const launcher = path.join(s.home, ".local", "bin", "sn");
  fs.renameSync(launcher, `${launcher}.prior`);
  fs.symlinkSync(path.join(REPO, "sn"), launcher);
  const status = s.sn(["status"]);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /bin\/sn is not the sn launcher recorded at install/);
  const verify = s.sn(["verify"]);
  assert.equal(verify.code, 1, verify.out);
  assert.match(verify.out, /bin\/sn is not the sn launcher recorded at install/);
  const removed = s.sn(["uninstall"]);
  assert.equal(removed.code, 0, removed.out);
  assert.equal(fs.readlinkSync(launcher), path.join(REPO, "sn"));
});

test("install never follows a launcher parent swapped just before link creation", (t) => {
  const s = sandbox(t, { localBin: false });
  const outside = path.join(s.home, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "user-data"), "keep me");
  const hook = path.join(s.home, "swap-parent.cjs");
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const symlink = fs.symlinkSync;",
    "fs.symlinkSync = (target, dest, type) => {",
    "  if (dest === 'sn' && target === process.env.SN_REPO_SN) {",
    "    const bin = path.join(process.env.HOME, '.local', 'bin');",
    "    fs.renameSync(bin, path.join(process.env.HOME, 'saved-bin'));",
    "    symlink(process.env.SN_OUTSIDE, bin);",
    "  }",
    "  return symlink(target, dest, type);",
    "};",
  ].join("\n"));
  const res = s.sn(INSTALL, { NODE_OPTIONS: `--require=${hook}`, SN_REPO_SN: path.join(REPO, "sn"), SN_OUTSIDE: outside });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /launcher parent changed during install/);
  assert.equal(fs.existsSync(path.join(outside, "sn")), false);
  assert.equal(fs.existsSync(path.join(s.home, "saved-bin", "sn")), false);
  assert.equal(fs.readFileSync(path.join(outside, "user-data"), "utf8"), "keep me");
});

test("a command appearing after preflight is preserved while other links roll back", (t) => {
  for (const repairing of [false, true]) {
    const s = sandbox(t);
    const launcher = path.join(s.home, ".local", "bin", "sn");
    if (repairing) {
      assert.equal(s.sn(INSTALL).code, 0);
      fs.unlinkSync(launcher);
    }
    const hook = path.join(s.home, "competing-command.cjs");
    fs.writeFileSync(hook, [
      "const fs = require('node:fs');",
      "const symlink = fs.symlinkSync;",
      "fs.symlinkSync = (target, dest, ...rest) => {",
      "  if (dest === 'sn') fs.writeFileSync('sn', 'user command', { flag: 'wx' });",
      "  return symlink(target, dest, ...rest);",
      "};",
    ].join("\n"));
    const before = snapshot(s.home);
    const install = repairing ? ["install", "--reuse", "--no-smoke"] : INSTALL;
    const res = s.sn(install, { NODE_OPTIONS: `--require=${hook}` });
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /install failed and was rolled back: .*appeared during install/);
    assert.equal(fs.readFileSync(launcher, "utf8"), "user command");
    fs.unlinkSync(launcher);
    assert.deepEqual(snapshot(s.home), before);
    assert.equal(fs.existsSync(s.manifestPath), repairing);
  }
});

test("uninstall and rollback preserve a launcher replaced at the removal syscall", (t) => {
  for (const command of ["uninstall", "status"]) {
    for (const replacement of ["file", "symlink"]) {
      const s = sandbox(t);
      assert.equal(s.sn(INSTALL).code, 0);
      if (command === "status") fs.writeFileSync(s.manifestPath, JSON.stringify(pendingFrom(s.manifest())));
      const launcher = path.join(s.home, ".local", "bin", "sn");
      const outside = path.join(s.home, "user-command");
      fs.writeFileSync(outside, "keep me");
      const hook = path.join(s.home, "swap-launcher.cjs");
      fs.writeFileSync(hook, [
        "const fs = require('node:fs');",
        "const rename = fs.renameSync;",
        "fs.renameSync = (from, to) => {",
        "  if (from === 'sn' && to.includes('.sn-removing-')) {",
        "    rename('sn', 'sn.prior');",
        "    if (process.env.SN_REPLACEMENT === 'file') fs.writeFileSync('sn', 'user command');",
        "    else fs.symlinkSync(process.env.SN_OUTSIDE, 'sn');",
        "  }",
        "  return rename(from, to);",
        "};",
      ].join("\n"));
      const res = s.sn([command], { NODE_OPTIONS: `--require=${hook}`, SN_REPLACEMENT: replacement, SN_OUTSIDE: outside });
      assert.equal(res.code, 0, res.out);
      assert.match(res.out, /launcher changed during removal/);
      if (replacement === "file") assert.equal(fs.readFileSync(launcher, "utf8"), "user command");
      else assert.equal(fs.readlinkSync(launcher), outside);
      assert.equal(fs.readFileSync(outside, "utf8"), "keep me");
    }
  }
});

test("removal quarantine cannot redirect through a swapped child directory", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const outside = path.join(s.home, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sn"), "user command");
  const hook = path.join(s.home, "replace-quarantine.cjs");
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const rename = fs.renameSync;",
    "fs.renameSync = (from, to) => {",
    "  if (from === 'sn' && to.includes('.sn-removing-') && path.dirname(to) !== '.') {",
    "    fs.rmdirSync(path.dirname(to));",
    "    fs.symlinkSync(process.env.SN_OUTSIDE, path.dirname(to));",
    "  }",
    "  return rename(from, to);",
    "};",
  ].join("\n"));
  const res = s.sn(["uninstall"], { NODE_OPTIONS: `--require=${hook}`, SN_OUTSIDE: outside });
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readFileSync(path.join(outside, "sn"), "utf8"), "user command");
  assert.equal(fs.existsSync(path.join(s.home, ".local", "bin", "sn")), false);
});

test("uninstall cannot unlink through a launcher parent swapped at removal", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const bin = path.join(s.home, ".local", "bin");
  const outside = path.join(s.home, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sn"), "user command");
  const hook = path.join(s.home, "swap-bin.cjs");
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const rename = fs.renameSync;",
    "fs.renameSync = (from, to) => {",
    "  if (from === 'sn' && to.includes('.sn-removing-')) {",
    "    const bin = path.join(process.env.HOME, '.local', 'bin');",
    "    rename(bin, path.join(process.env.HOME, 'saved-bin'));",
    "    fs.symlinkSync(process.env.SN_OUTSIDE, bin);",
    "  }",
    "  return rename(from, to);",
    "};",
  ].join("\n"));
  const res = s.sn(["uninstall"], { NODE_OPTIONS: `--require=${hook}`, SN_OUTSIDE: outside });
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readFileSync(path.join(outside, "sn"), "utf8"), "user command");
  assert.equal(fs.existsSync(path.join(s.home, "saved-bin", "sn")), false);
  assert.ok(fs.lstatSync(bin).isSymbolicLink());
});

test("recovery retains a launcher published before its ownership was recorded", (t) => {
  for (const repairing of [false, true]) {
    const s = sandbox(t);
    const launcher = path.join(s.home, ".local", "bin", "sn");
    let previousIdentity = null;
    if (repairing) {
      assert.equal(s.sn(INSTALL).code, 0);
      previousIdentity = s.manifest().launcherIdentity;
      fs.unlinkSync(launcher);
    }
    const hook = path.join(s.home, "crash-after-launcher.cjs");
    fs.writeFileSync(hook, [
      "const fs = require('node:fs');",
      "const symlink = fs.symlinkSync;",
      "fs.symlinkSync = (target, name, ...rest) => {",
      "  symlink(target, name, ...rest);",
      "  if (name === 'sn') process.exit(75);",
      "};",
    ].join("\n"));
    const install = repairing ? ["install", "--reuse", "--no-smoke"] : INSTALL;
    assert.equal(s.sn(install, { NODE_OPTIONS: `--require=${hook}` }).code, 75);
    assert.equal(fs.readlinkSync(launcher), path.join(REPO, "sn"));
    assert.equal(s.manifest().status, "pending");
    assert.deepEqual(s.manifest().launcherIdentity, previousIdentity);
    const before = snapshot(s.home);
    const blocked = s.sn(["status"]);
    assert.equal(blocked.code, 1, blocked.out);
    assert.match(blocked.out, /unverified launcher at .*bin\/sn/);
    assert.deepEqual(snapshot(s.home), before);
    fs.unlinkSync(launcher);
    assert.equal(s.sn(["status"]).code, 0);
    assert.equal(fs.existsSync(s.manifestPath), repairing);
    assert.equal(s.sn(install).code, 0);
    assert.equal(s.sn(["uninstall"]).code, 0);
  }
});

test("a failure mid-install rolls everything back", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.file("skills"));
  fs.mkdirSync(s.file("agents"));
  const before = snapshot(s.home);
  fs.chmodSync(s.agentDir, 0o555);
  const res = s.sn(INSTALL);
  fs.chmodSync(s.agentDir, 0o755);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /install failed and was rolled back/);
  assert.deepEqual(snapshot(s.home), before);
  assert.ok(!fs.existsSync(s.snHome));
});

test("a failure during a re-install restores the previous installation", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  const installed = snapshot(s.home);
  fs.chmodSync(s.agentDir, 0o555);
  const res = s.sn([...INSTALL, "--approval", "write"]);
  fs.chmodSync(s.agentDir, 0o755);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /rolled back/);
  assert.deepEqual(snapshot(s.home), installed);
  assert.equal(s.sn(["verify"]).code, 0);
});

test("an interrupted install found by the next command is rolled back first", (t) => {
  const s = sandbox(t);
  s.write("AGENTS.md", "# mine\n");
  const before = snapshot(s.home);
  assert.equal(s.sn(INSTALL).code, 0);
  const m = s.manifest();
  const backup = m.files.agents.backup;
  const pending = {
    ...m,
    status: "pending",
    txn: {
      backupDir: path.dirname(backup),
      files: Object.entries(m.files).map(([kind, f]) => ({
        kind, path: f.path, existed: !f.created, backup: f.backup, backupHash: f.backupHash, afterHash: f.postHash,
      })),
      symlinks: m.symlinks.map((p) => ({ path: p, previous: null })),
      dirs: m.createdDirs,
      previous: null,
    },
  };
  fs.writeFileSync(s.manifestPath, JSON.stringify(pending));
  const res = s.sn(["status"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /interrupted install; rolling it back/);
  assert.match(res.out, /not installed/);
  assert.deepEqual(snapshot(s.home), before);
});

test("OMP profile selection decides the agent dir and is honoured by uninstall", (t) => {
  const s = sandbox(t);
  const profileDir = path.join(s.home, ".omp", "profiles", "work", "agent");
  const custom = path.join(s.home, "custom-agent");
  fs.mkdirSync(custom);

  const res = s.sn(INSTALL, { OMP_PROFILE: "work", PI_CODING_AGENT_DIR: custom });
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readlinkSync(path.join(profileDir, "skills", "super-nemo")), path.join(REPO, "skills", "super-nemo"));
  assert.deepEqual(fs.readdirSync(custom), []);
  assert.ok(!fs.existsSync(s.file("skills")));

  const wrong = s.sn(["uninstall"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /installed for agent dir .*profiles\/work\/agent/);
  assert.ok(fs.existsSync(path.join(profileDir, "skills", "super-nemo")));

  assert.equal(s.sn(["uninstall", "--profile", "work"]).code, 0);
  assert.ok(!fs.existsSync(path.join(profileDir, "skills")));
  assert.ok(!fs.existsSync(s.snHome));
});

test("PI_CODING_AGENT_DIR is used for the default profile", (t) => {
  const s = sandbox(t);
  const custom = path.join(s.home, "custom-agent");
  fs.mkdirSync(custom);
  const res = s.sn(INSTALL, { PI_CODING_AGENT_DIR: custom });
  assert.equal(res.code, 0, res.out);
  assert.ok(fs.lstatSync(path.join(custom, "agents", "nemo-qa.md")).isSymbolicLink());
  assert.equal(YAML.parse(fs.readFileSync(path.join(custom, "config.yml"), "utf8")).tools.approvalMode, "yolo");
  assert.equal(s.sn(["uninstall"], { PI_CODING_AGENT_DIR: custom }).code, 0);
  assert.deepEqual(fs.readdirSync(custom).filter((n) => !n.startsWith("agent.db")), []);
});

test("an unsafe profile name is rejected", (t) => {
  const s = sandbox(t);
  const res = s.sn(["status", "--profile", "../../etc"]);
  assert.equal(res.code, 2);
  assert.match(res.out, /invalid profile name/);
});

test("rollback removes our entries from a config edited after the interrupted write", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  const original = YAML.parse(s.read("config.yml"));
  assert.equal(s.sn(INSTALL).code, 0);
  fs.writeFileSync(s.manifestPath, JSON.stringify(pendingFrom(s.manifest())));
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["theme", "light"], "paper");
  s.write("config.yml", doc.toString());
  const res = s.sn(["status"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /not installed/);
  assert.deepEqual(YAML.parse(s.read("config.yml")), { ...original, theme: { dark: "midnight", light: "paper" } });
  assert.equal(s.read("AGENTS.md"), "# My rules\n\nAlways answer in English.\n");
  assert.ok(!fs.existsSync(s.manifestPath));
});

test("rollback leaves a file deleted after the interrupted write deleted", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  fs.writeFileSync(s.manifestPath, JSON.stringify(pendingFrom(s.manifest())));
  fs.unlinkSync(s.file("WATCHDOG.md"));
  const res = s.sn(["status"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /WATCHDOG\.md was deleted after the interrupted install/);
  assert.ok(!fs.existsSync(s.file("WATCHDOG.md")));
  assert.ok(!fs.existsSync(s.manifestPath));
});

test("rollback keeps the pending state when a changed file cannot be unmerged", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  fs.writeFileSync(s.manifestPath, JSON.stringify(pendingFrom(s.manifest())));
  s.write("config.yml", `${s.read("config.yml")}broken: [\n`);
  const before = snapshot(s.home);
  const res = s.sn(["status"]);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /cannot be rolled back automatically[\s\S]*config\.yml changed after the interrupted install/);
  assert.deepEqual(snapshot(s.home), before);
  assert.equal(s.manifest().status, "pending");
});

test("rollback with a missing backup changes nothing and keeps the pending state", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  const m = s.manifest();
  fs.writeFileSync(s.manifestPath, JSON.stringify(pendingFrom(m)));
  fs.unlinkSync(path.join(s.snHome, "state", m.files.config.backup));
  const before = snapshot(s.home);
  for (const cmd of [["status"], ["uninstall"], INSTALL]) {
    const res = s.sn(cmd);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /cannot be rolled back automatically[\s\S]*config\.yml: backup .* is missing or damaged/);
  }
  assert.deepEqual(snapshot(s.home), before);
  assert.equal(s.manifest().status, "pending");
});

test("uninstall with an unreadable managed file changes nothing until the file is fixed", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  const original = snapshot(s.home);
  assert.equal(s.sn(INSTALL).code, 0);
  const good = s.read("config.yml");
  s.write("config.yml", `${good}broken: [\n`);
  const before = snapshot(s.home);
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /Uninstall incomplete, nothing was changed[\s\S]*config\.yml: invalid YAML/);
  assert.deepEqual(snapshot(s.home), before);
  s.write("config.yml", good);
  const again = s.sn(["uninstall"]);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(snapshot(s.home), original);
});

test("uninstall ignores manifest config keys SUPER-NEMO does not manage", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  const m = s.manifest();
  m.config.keys["theme.dark"] = { prior: { absent: true }, ours: "midnight" };
  m.config.patterns.inserted.push({ match: "*rm -rf /*", approval: "deny" });
  fs.writeFileSync(s.manifestPath, JSON.stringify(m));
  s.write("AGENTS.md", `${s.read("AGENTS.md")}more\n`);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["theme", "light"], "paper");
  s.write("config.yml", doc.toString());
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /ignored manifest entry, config key theme\.dark/);
  assert.match(res.out, /ignored manifest entry, bash\.patterns entry .*rm -rf/);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.theme.dark, "midnight");
  assert.deepEqual(config.bash.patterns, [{ match: "*rm -rf /*", approval: "deny" }, { match: "npm test*", approval: "allow" }]);
});

test("a symlinked backup dir is neither restored from nor deleted", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  const m = s.manifest();
  const tsDir = path.join(s.snHome, "state", path.dirname(m.files.agents.backup));
  const outside = path.join(s.home, "outside");
  fs.renameSync(tsDir, outside);
  fs.symlinkSync(outside, tsDir);
  fs.writeFileSync(path.join(outside, "AGENTS.md"), "EVIL\n");
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(s.read("AGENTS.md"), "# My rules\n\nAlways answer in English.\n");
  assert.equal(fs.readFileSync(path.join(outside, "AGENTS.md"), "utf8"), "EVIL\n");
  assert.ok(fs.existsSync(path.join(outside, "config.yml")));
});

test("a symlinked backups directory blocks uninstall before any link or file changes", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  const backups = path.join(s.snHome, "state", "backups");
  const moved = path.join(s.snHome, "saved-backups");
  fs.renameSync(backups, moved);
  fs.symlinkSync(moved, backups);
  const before = snapshot(s.home);
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /Uninstall incomplete, nothing was changed[\s\S]*backups is not a plain directory/);
  assert.deepEqual(snapshot(s.home), before);
  assert.equal(s.manifest().status, "installed");
});

test("uninstall preserves a symlinked update cache and does not follow it", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const victim = path.join(s.home, "user-cache.json");
  const text = JSON.stringify({ tool: "super-nemo", checkedAt: 1000 });
  fs.writeFileSync(victim, text);
  const cache = path.join(s.snHome, "state", "update-check.json");
  fs.symlinkSync(victim, cache);
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /left .*update-check\.json: not a valid SUPER-NEMO update cache/);
  assert.equal(fs.readFileSync(victim, "utf8"), text);
  assert.equal(fs.readlinkSync(cache), victim);
});

test("uninstall preserves malformed or unrelated update cache contents", (t) => {
  for (const text of ["not JSON", JSON.stringify({ tool: "other", checkedAt: 1000 }), JSON.stringify({ tool: "super-nemo", checkedAt: "1000" }), JSON.stringify({ tool: "super-nemo", checkedAt: 1000, note: "user" })]) {
    const s = sandbox(t);
    assert.equal(s.sn(INSTALL).code, 0);
    const cache = path.join(s.snHome, "state", "update-check.json");
    fs.writeFileSync(cache, text, { mode: 0o600 });
    const res = s.sn(["uninstall"]);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /left .*update-check\.json: not a valid SUPER-NEMO update cache/);
    assert.equal(fs.readFileSync(cache, "utf8"), text);
  }
});

test("uninstall preserves an unowned update lock", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const lock = path.join(s.snHome, "state", ".update-check.lock");
  const victim = path.join(s.home, "user-lock");
  fs.writeFileSync(victim, "user data");
  fs.symlinkSync(victim, lock);
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /left .*\.update-check\.lock: not a valid SUPER-NEMO update lock/);
  assert.equal(fs.readFileSync(victim, "utf8"), "user data");
  assert.equal(fs.readlinkSync(lock), victim);
});

test("uninstall never deletes a cache replaced between validation and isolation", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const cache = path.join(s.snHome, "state", "update-check.json");
  const text = JSON.stringify({ tool: "super-nemo", checkedAt: 1000 });
  fs.writeFileSync(cache, text, { mode: 0o600 });
  const hook = path.join(s.home, "swap-cache.cjs");
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    "const rename = fs.renameSync;",
    "fs.renameSync = (from, to) => {",
    "  if (from === process.env.SN_SWAP_CACHE && to.includes('.update-check-removing-')) {",
    "    rename(from, `${from}.prior`);",
    "    fs.writeFileSync(from, JSON.stringify({ tool: 'super-nemo', checkedAt: 2000 }), { mode: 0o600 });",
    "  }",
    "  return rename(from, to);",
    "};",
  ].join("\n"));
  const res = s.sn(["uninstall"], { NODE_OPTIONS: `--require=${hook}`, SN_SWAP_CACHE: cache });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /update cache changed while uninstalling/);
  assert.equal(fs.readFileSync(cache, "utf8"), JSON.stringify({ tool: "super-nemo", checkedAt: 2000 }));
  assert.equal(fs.readFileSync(`${cache}.prior`, "utf8"), text);
});

test("uninstall preserves a cache replaced by a symlink or directory during isolation", (t) => {
  for (const kind of ["symlink", "directory"]) {
    const s = sandbox(t);
    assert.equal(s.sn(INSTALL).code, 0);
    const cache = path.join(s.snHome, "state", "update-check.json");
    fs.writeFileSync(cache, JSON.stringify({ tool: "super-nemo", checkedAt: 1000 }), { mode: 0o600 });
    const victim = path.join(s.home, "user-data");
    fs.writeFileSync(victim, "keep me");
    const hook = path.join(s.home, "swap-cache.cjs");
    fs.writeFileSync(hook, [
      "const fs = require('node:fs');",
      "const rename = fs.renameSync;",
      "fs.renameSync = (from, to) => {",
      "  if (from === process.env.SN_SWAP_CACHE && to.includes('.update-check-removing-')) {",
      "    rename(from, `${from}.prior`);",
      "    if (process.env.SN_SWAP_KIND === 'symlink') fs.symlinkSync(process.env.SN_VICTIM, from);",
      "    else { fs.mkdirSync(from); fs.writeFileSync(`${from}/user-data`, 'keep me'); }",
      "  }",
      "  return rename(from, to);",
      "};",
    ].join("\n"));
    const res = s.sn(["uninstall"], {
      NODE_OPTIONS: `--require=${hook}`, SN_SWAP_CACHE: cache, SN_SWAP_KIND: kind, SN_VICTIM: victim,
    });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /update cache changed while uninstalling/);
    assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
    if (kind === "symlink") assert.equal(fs.readlinkSync(cache), victim);
    else {
      const quarantine = fs.readdirSync(path.join(s.snHome, "state")).find((entry) => entry.startsWith(".update-check-removing-"));
      assert.ok(quarantine, res.out);
      assert.equal(fs.readFileSync(path.join(s.snHome, "state", quarantine, "update-check.json", "user-data"), "utf8"), "keep me");
    }
  }
});

test("uninstall does not remove a cache through a symlinked SUPER-NEMO home", (t) => {
  const s = sandbox(t);
  const external = path.join(s.home, "user-state");
  fs.mkdirSync(external);
  fs.symlinkSync(external, s.snHome);
  assert.equal(s.sn(INSTALL).code, 0);
  const cache = path.join(external, "state", "update-check.json");
  const text = JSON.stringify({ tool: "super-nemo", checkedAt: 1000 });
  fs.writeFileSync(cache, text, { mode: 0o600 });
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /left .*update-check\.json: not a valid SUPER-NEMO update cache/);
  assert.equal(fs.readFileSync(cache, "utf8"), text);
  assert.ok(fs.lstatSync(s.snHome).isSymbolicLink());
});

test("uninstall preserves a cache under a symlinked state parent", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const state = path.join(s.snHome, "state");
  const moved = path.join(s.snHome, "saved-state");
  fs.renameSync(state, moved);
  fs.symlinkSync(moved, state);
  const cache = path.join(moved, "update-check.json");
  const text = JSON.stringify({ tool: "super-nemo", checkedAt: 1000 });
  fs.writeFileSync(cache, text, { mode: 0o600 });
  const before = snapshot(s.home);
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 1, res.out);
  assert.deepEqual(snapshot(s.home), before);
  assert.equal(fs.readFileSync(cache, "utf8"), text);
  assert.ok(fs.lstatSync(state).isSymbolicLink());
});

test("uninstall leaves an extension behind a swapped symlinked parent untouched", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const extensions = s.file("extensions");
  const elsewhere = path.join(s.home, "my-extensions");
  fs.renameSync(extensions, elsewhere);
  fs.symlinkSync(elsewhere, extensions);
  const status = s.sn(["status"]);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /Links:\n[\s\S]*extensions\/super-nemo\.js has an unsafe parent directory/);
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readlinkSync(path.join(elsewhere, "super-nemo.js")), path.join(REPO, "extensions", "super-nemo.js"));
  assert.ok(fs.lstatSync(extensions).isSymbolicLink());
  assert.match(res.out, /left .*extensions\/super-nemo\.js: not a path this installer manages/);
});

test("an agents dir swapped for a symlink before uninstall is left alone", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const elsewhere = path.join(s.home, "elsewhere-agents");
  fs.renameSync(s.file("agents"), elsewhere);
  fs.symlinkSync(elsewhere, s.file("agents"));
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readlinkSync(path.join(elsewhere, "nemo-qa.md")), path.join(REPO, "agents", "nemo-qa.md"));
  assert.ok(fs.lstatSync(s.file("agents")).isSymbolicLink());
  assert.match(res.out, /left .*agents\/nemo-qa\.md: not a path this installer manages/);
});

test("commands abort when the agent dir now resolves somewhere else", (t) => {
  const s = sandbox(t);
  const a = path.join(s.home, "agent-a");
  const b = path.join(s.home, "agent-b");
  const link = path.join(s.home, "agent-link");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.symlinkSync(a, link);
  assert.equal(s.sn(INSTALL, { PI_CODING_AGENT_DIR: link }).code, 0);
  assert.equal(s.manifest().agentDir, a);
  fs.unlinkSync(link);
  fs.symlinkSync(b, link);
  const before = snapshot(s.home);
  const res = s.sn(["uninstall"], { PI_CODING_AGENT_DIR: link });
  assert.equal(res.code, 1);
  assert.match(res.out, /now resolve to .*agent-b/);
  assert.deepEqual(snapshot(s.home), before);
});

test("a forged repo path does not make an unrelated symlink look like ours", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const other = path.join(s.home, "other-project");
  fs.mkdirSync(path.join(other, "skills", "super-nemo"), { recursive: true });
  const link = path.join(s.agentDir, "skills", "super-nemo");
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(other, "skills", "super-nemo"), link);
  fs.writeFileSync(s.manifestPath, JSON.stringify({ ...s.manifest(), repo: other }));
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readlinkSync(link), path.join(other, "skills", "super-nemo"));
  assert.match(res.out, /left .*skills\/super-nemo: not a symlink into/);
});

test("uninstall removes the ~/.omp tree it created once it is empty", (t) => {
  const s = sandbox(t, { agentDir: false });
  assert.equal(s.sn(INSTALL).code, 0);
  for (const name of fs.readdirSync(s.agentDir)) if (name.startsWith("agent.db") || name.startsWith("models.db")) fs.rmSync(s.file(name));
  for (const name of ["logs", "natives"]) fs.rmSync(path.join(s.home, ".omp", name), { recursive: true, force: true });
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.ok(!fs.existsSync(path.join(s.home, ".omp")));
});

test("an install whose state has gone missing is reported instead of installed twice", (t) => {
  const s = sandbox(t);
  const real = path.join(s.home, "sn-real");
  const empty = path.join(s.home, "sn-empty");
  fs.mkdirSync(real);
  fs.mkdirSync(empty);
  fs.symlinkSync(real, s.snHome);
  assert.equal(s.sn(INSTALL).code, 0);
  fs.unlinkSync(s.snHome);
  fs.symlinkSync(empty, s.snHome);
  const before = snapshot(s.home);
  for (const cmd of [["status"], ["uninstall"], INSTALL]) {
    const res = s.sn(cmd);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /installed in .* but its state is missing at .*sn-empty\/state/);
  }
  assert.deepEqual(snapshot(s.home), before);
});

function interruptReinstall(s, previous, files, { backupHash } = {}) {
  const ts = "2000-01-01T00-00-00-000Z";
  const dir = path.join(s.snHome, "state", "backups", ts);
  fs.mkdirSync(dir, { recursive: true });
  const txnFiles = files.map(([kind, name, before]) => {
    fs.writeFileSync(path.join(dir, name), before);
    return {
      kind, path: s.file(name), existed: true, backup: `backups/${ts}/${name}`, backupHash: backupHash ?? sha(before), afterHash: sha(s.read(name)),
    };
  });
  const txn = { backupDir: `backups/${ts}`, files: txnFiles, symlinks: [], removedLinks: [], dirs: [], previous };
  fs.writeFileSync(s.manifestPath, JSON.stringify({ ...s.manifest(), status: "pending", txn }));
}

test("an interrupted re-install over a drifted key is rolled back from its own backup", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approvalMode"], "always-ask");
  s.write("config.yml", doc.toString());
  const previous = s.manifest();
  const beforeReinstall = s.read("config.yml");
  const re = s.sn([...INSTALL, "--approval", "yolo", "--overwrite-drift"]);
  assert.equal(re.code, 0, re.out);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approvalMode, "yolo");
  interruptReinstall(s, previous, [["config", "config.yml", beforeReinstall]]);
  const later = YAML.parseDocument(s.read("config.yml"));
  later.setIn(["theme", "light"], "paper");
  s.write("config.yml", later.toString());

  const res = s.sn(["status"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /interrupted install; rolling it back/);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.tools.approvalMode, "always-ask");
  assert.equal(config.theme.light, "paper");
  assert.deepEqual({ ...config, theme: YAML.parse(beforeReinstall).theme }, YAML.parse(beforeReinstall));
  assert.equal(s.manifest().status, "installed");
  assert.equal(s.manifest().choices.approval, "yolo");
  assert.ok(!fs.existsSync(path.join(s.snHome, "state", "backups", "2000-01-01T00-00-00-000Z")));
});

test("an interrupted re-install that rewrote an edited block restores that block and keeps later edits outside it", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  const edited = s.read("AGENTS.md").replace("@~/.super-nemo/current/blocks/AGENTS.md\n", "@~/.super-nemo/current/blocks/AGENTS.md\nmy own line in the block\n");
  s.write("AGENTS.md", edited);
  const previous = s.manifest();
  assert.equal(s.sn(INSTALL).code, 0);
  assert.doesNotMatch(s.read("AGENTS.md"), /my own line/);
  interruptReinstall(s, previous, [["agents", "AGENTS.md", edited]]);
  s.write("AGENTS.md", `${s.read("AGENTS.md")}written later\n`);

  const res = s.sn(["status"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(s.read("AGENTS.md"), `${edited}written later\n`);
  assert.equal(s.manifest().status, "installed");
});

test("recovery removes a block the backup did not have without eating the user's blank line before it", (t) => {
  for (const [edit, expected] of [
    [(b, block) => `${b}\nA new paragraph.\n\n${block}`, (b) => `${b}\nA new paragraph.\n\n`],
    [(b, block) => `${b}\n${block}written later\n`, (b) => `${b}written later\n`],
  ]) {
    const s = sandbox(t);
    seedUserContent(s);
    assert.equal(s.sn(INSTALL).code, 0);
    const original = "# My rules\n\nAlways answer in English.\n";
    s.write("AGENTS.md", original);
    const previous = s.manifest();
    assert.equal(s.sn(INSTALL).code, 0);
    const block = s.read("AGENTS.md").slice(original.length + 1);
    assert.match(block, /^<!-- super-nemo:begin -->/);
    interruptReinstall(s, previous, [["agents", "AGENTS.md", original]]);
    s.write("AGENTS.md", edit(original, block));
    const res = s.sn(["status"]);
    assert.equal(res.code, 0, res.out);
    assert.equal(s.read("AGENTS.md"), expected(original));
  }
});

test("an interrupted re-install whose backup cannot be verified changes nothing and keeps the pending state", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  const previous = s.manifest();
  const beforeReinstall = s.read("config.yml");
  assert.equal(s.sn([...INSTALL, "--approval", "yolo"]).code, 0);
  interruptReinstall(s, previous, [["config", "config.yml", beforeReinstall]], { backupHash: "0" });
  s.write("config.yml", `${s.read("config.yml")}extra: 1\n`);
  const before = snapshot(s.home);
  const res = s.sn(["status"]);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /cannot be rolled back automatically[\s\S]*config\.yml: backup .* is missing or damaged/);
  assert.deepEqual(snapshot(s.home), before);
  assert.equal(s.manifest().status, "pending");
});

test("state dirs are 0700 and the manifest and backups 0600 under umask 022; modes we did not create stay", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  fs.chmodSync(s.file("config.yml"), 0o640);
  fs.mkdirSync(s.snHome);
  fs.chmodSync(s.snHome, 0o755);
  const sn = (args) => s.run("bash", ["-c", 'umask 022; exec "$0" "$@"', path.join(REPO, "sn"), ...args]);
  const mode = (p) => fs.statSync(p).mode & 0o777;
  const backups = path.join(s.snHome, "state", "backups");
  const check = () => {
    assert.equal(mode(path.join(s.snHome, "state")), 0o700);
    assert.equal(mode(backups), 0o700);
    assert.equal(mode(s.manifestPath), 0o600);
    const dirs = fs.readdirSync(backups);
    assert.ok(dirs.length > 0);
    for (const d of dirs) {
      assert.equal(mode(path.join(backups, d)), 0o700);
      for (const f of fs.readdirSync(path.join(backups, d))) assert.equal(mode(path.join(backups, d, f)), 0o600, f);
    }
  };
  assert.equal(sn(INSTALL).code, 0);
  check();
  s.write("AGENTS.md", `${s.read("AGENTS.md")}more\n`);
  assert.equal(sn([...INSTALL, "--approval", "yolo"]).code, 0);
  check();
  assert.equal(mode(s.file("config.yml")), 0o640);
  assert.equal(mode(s.snHome), 0o755);
});
