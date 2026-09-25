import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { INSTALL, INTERNAL, seedUserContent, sandbox, snapshot, withoutKeyRefs } from "./helpers.mjs";

const setIn = (s, mutate) => {
  const doc = YAML.parseDocument(s.read("config.yml"));
  mutate(doc);
  s.write("config.yml", doc.toString());
};

test("uninstall keeps a managed key the user changed, reports it, and reverts the rest", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  setIn(s, (doc) => doc.setIn(["tools", "approvalMode"], "always-ask"));
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0);
  assert.match(res.out, /^ {2}! Auto-approve: you changed this to off \(asks before every command\); kept it \(config\.yml: tools\.approvalMode\)$/m);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.tools.approvalMode, "always-ask");
  assert.equal(config.tools.approval, undefined);
  assert.deepEqual(config.modelRoles, { default: "beta/sol:medium", smol: "alpha/small" });
  assert.equal(config.task, undefined);
  assert.equal(config.advisor, undefined);
  assert.deepEqual(config.bash.patterns, [
    { match: "*rm -rf /*", approval: "deny" },
    { match: "npm test*", approval: "allow" },
  ]);
  assert.equal(config.theme.dark, "midnight");
});

test("reinstall with a drifted key: exit 3 without writing, then --overwrite-drift replaces it", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  setIn(s, (doc) => doc.setIn(["modelRoles", "nemo-review"], "alpha/small:low"));
  const before = snapshot(s.home);
  const res = s.sn([...INSTALL, "--review", "beta/sol:medium"]);
  assert.equal(res.code, 3, res.out);
  assert.match(res.out, /^ {2}! Reviewers: you changed this to small - low \(config\.yml: modelRoles\.nemo-review\)$/m);
  assert.doesNotMatch(withoutKeyRefs(res.out), INTERNAL);
  assert.deepEqual(snapshot(s.home), before);

  const forced = s.sn([...INSTALL, "--review", "beta/sol:medium", "--overwrite-drift"]);
  assert.equal(forced.code, 0, forced.out);
  assert.equal(YAML.parse(s.read("config.yml")).modelRoles["nemo-review"], "beta/sol:medium");
});

test("status, a drift stop and uninstall name changed settings in plain words, with the key only in a trailing parenthesis", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  setIn(s, (doc) => {
    doc.setIn(["modelRoles", "nemo-review"], "alpha/small:low");
    doc.setIn(["task", "agentModelOverrides", "scout"], "@nemo-review");
    doc.setIn(["tools", "approvalMode"], "yolo");
  });
  const expected = [
    /^ {2}! Reviewers: you changed this to small - low \(config\.yml: modelRoles\.nemo-review\)$/m,
    /^ {2}! Model for scout: you changed this to Reviewers model \(config\.yml: task\.agentModelOverrides\.scout\)$/m,
    /^ {2}! Auto-approve: you changed this to on \(config\.yml: tools\.approvalMode\)$/m,
  ];
  const st = s.sn(["status"]);
  assert.equal(st.code, 0, st.out);
  for (const line of expected) assert.match(st.out, line);
  assert.doesNotMatch(withoutKeyRefs(st.out), INTERNAL);

  const check = s.sn(["verify"]);
  assert.equal(check.code, 1, check.out);
  assert.match(check.out, /^x Reviewers: is small - low, expected sol - high \(config\.yml: modelRoles\.nemo-review\)$/m);
  assert.match(check.out, /^x Model for scout: is Reviewers model, expected same as main \(config\.yml: task\.agentModelOverrides\.scout\)$/m);
  assert.match(check.out, /^x Auto-approve: is on, expected off \(config\.yml: tools\.approvalMode\)$/m);

  const stop = s.sn([...INSTALL, "--review", "beta/sol:medium"]);
  assert.equal(stop.code, 3, stop.out);
  for (const line of expected) assert.match(stop.out, line);
  assert.doesNotMatch(withoutKeyRefs(stop.out), INTERNAL);

  const un = s.sn(["uninstall"]);
  assert.equal(un.code, 0, un.out);
  assert.match(un.out, /^ {2}! Reviewers: you changed this to small - low; kept it \(config\.yml: modelRoles\.nemo-review\)$/m);
  assert.match(un.out, /^ {2}! Model for scout: you changed this to Reviewers model; kept it \(config\.yml: task\.agentModelOverrides\.scout\)$/m);
  assert.doesNotMatch(withoutKeyRefs(un.out), INTERNAL);
});

test("reinstall keeps the value the user chose when their change matches the new answer", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  setIn(s, (doc) => doc.setIn(["modelRoles", "nemo-review"], "beta/sol:low"));
  const res = s.sn([...INSTALL, "--review", "beta/sol:low"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(s.manifest().config.keys["modelRoles.nemo-review"].ours, "beta/sol:low");
});

test("fast on, then off, then uninstall restores the original config", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  const original = s.read("config.yml");
  assert.equal(s.sn([...INSTALL, "--fast", "alpha/small"]).code, 0);
  assert.equal(YAML.parse(s.read("config.yml")).modelRoles["nemo-fast"], "alpha/small:low");
  assert.equal(s.sn([...INSTALL, "--fast", "none"]).code, 0);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.modelRoles["nemo-fast"], undefined);
  assert.equal(config.task.agentModelOverrides.scout, "@default");
  assert.equal(s.manifest().config.keys["modelRoles.nemo-fast"], undefined);
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.equal(s.read("config.yml"), original);
});

test("advisor off, then on, then uninstall removes every key we added", (t) => {
  const s = sandbox(t);
  s.write("config.yml", "theme:\n  dark: midnight\n");
  assert.equal(s.sn([...INSTALL, "--advisor", "off"]).code, 0);
  assert.equal(s.sn([...INSTALL, "--advisor", "beta/sol"]).code, 0);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.task.agentAdvisor, undefined);
  assert.equal(config.modelRoles.advisor, "beta/sol:medium");
  assert.equal(config.modelRoles["advisor-critical"], "beta/sol:high");
  setIn(s, (doc) => doc.setIn(["theme", "light"], "paper"));
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(YAML.parse(s.read("config.yml")), { theme: { dark: "midnight", light: "paper" } });
});

test("prior values come from the first install and survive later runs with other answers", (t) => {
  const s = sandbox(t);
  s.write("config.yml", "tools:\n  approvalMode: always-ask\nmodelRoles:\n  default: beta/sol:medium\n");
  const original = s.read("config.yml");
  assert.equal(s.sn([...INSTALL, "--approval", "yolo", "--impl", "alpha/big"]).code, 0);
  assert.equal(s.sn([...INSTALL, "--approval", "write", "--impl", "alpha/small:medium"]).code, 0);
  const keys = s.manifest().config.keys;
  assert.deepEqual(keys["tools.approvalMode"], { prior: { value: "always-ask" }, ours: "write" });
  assert.deepEqual(keys["modelRoles.default"], { prior: { value: "beta/sol:medium" }, ours: "alpha/small:medium" });
  setIn(s, (doc) => doc.setIn(["theme"], "dark"));
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(YAML.parse(s.read("config.yml")), { ...YAML.parse(original), theme: "dark" });
});

test("links into another checkout are conflicts, not ours", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const oldCheckout = path.join(s.home, "old-super-nemo");
  const link = path.join(s.agentDir, "skills", "super-nemo");
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(oldCheckout, "skills", "super-nemo"), link);
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /skills\/super-nemo already exists \(symlink to .*old-super-nemo/);
  assert.deepEqual(snapshot(s.home), before);
});
