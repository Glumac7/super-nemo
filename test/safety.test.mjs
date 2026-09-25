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
  const res = s.sn([...INSTALL, "--approval", "yolo"]);
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
  assert.equal(YAML.parse(fs.readFileSync(path.join(custom, "config.yml"), "utf8")).tools.approvalMode, "write");
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
  assert.deepEqual(s.manifest().createdDirs.filter((d) => !d.endsWith("skills") && !d.endsWith("agents")), [path.join(s.home, ".omp"), s.agentDir]);
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
  assert.equal(s.manifest().choices.approval, "write");
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
