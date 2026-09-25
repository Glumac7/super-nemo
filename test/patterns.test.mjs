import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { INSTALL, REPO, sandbox } from "./helpers.mjs";

const OURS = JSON.parse(fs.readFileSync(path.join(REPO, "config", "deny-patterns.json"), "utf8"));
const USER = [{ match: "*rm -rf /*", approval: "deny" }, { match: "npm test*", approval: "allow" }];
const MAKE = { match: "make*", approval: "allow" };

const patterns = (s) => YAML.parse(s.read("config.yml")).bash.patterns;
const owned = (list) => list.filter((p) => OURS.some((o) => o.match === p.match && o.approval === p.approval));

function edit(s, mutate) {
  const doc = YAML.parseDocument(s.read("config.yml"));
  mutate(doc);
  s.write("config.yml", doc.toString());
}

const insertBefore = (match, entry) => (doc) => {
  const items = doc.getIn(["bash", "patterns"]).items;
  items.splice(items.findIndex((n) => n.get("match") === match), 0, doc.createNode(entry));
};

test("an identical user copy of our deny added after install makes it ambiguous: both copies and the user's comment stay", (t) => {
  const s = sandbox(t);
  s.write("config.yml", "bash:\n  patterns:\n    - match: \"npm test*\"\n      approval: allow\n");
  assert.equal(s.sn(INSTALL).code, 0);
  const text = s.read("config.yml").replace(
    "    - match: \"npm test*\"",
    "    # keep secrets out of logs\n    - match: \"*printenv*\"\n      approval: deny\n    - match: \"npm test*\"",
  );
  s.write("config.yml", text);
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /ambiguous duplicate \{"match":"\*printenv\*","approval":"deny"\} kept/);
  assert.match(s.read("config.yml"), /# keep secrets out of logs\n\s+- match: "\*printenv\*"/);
  assert.deepEqual(patterns(s), [
    { match: "*printenv*", approval: "deny" },
    { match: "*printenv*", approval: "deny" },
    { match: "npm test*", approval: "allow" },
  ]);
});

test("after the user edits the list, uninstall removes only our entries and keeps theirs in order", (t) => {
  const s = sandbox(t);
  s.write("config.yml", YAML.stringify({ bash: { patterns: USER } }));
  assert.equal(s.sn(INSTALL).code, 0);
  edit(s, insertBefore("npm test*", MAKE));
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(patterns(s), [USER[0], MAKE, USER[1]]);
});

test("the recorded baseline survives re-installs, so uninstall restores the original list", (t) => {
  const s = sandbox(t);
  s.write("config.yml", YAML.stringify({ bash: { patterns: USER } }));
  assert.equal(s.sn(INSTALL).code, 0);
  const first = s.manifest().config.patterns;
  assert.deepEqual(first.before, { value: USER });
  assert.deepEqual(first.after, patterns(s));

  assert.match(s.sn(INSTALL).out, /Nothing to change/);
  assert.equal(s.sn([...INSTALL, "--approval", "yolo"]).code, 0);
  assert.deepEqual(s.manifest().config.patterns.before, { value: USER });
  edit(s, (doc) => doc.set("theme", "dark"));
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(patterns(s), USER);
  assert.equal(owned(patterns(s)).length, 0);
});

test("a re-install after the user edited the list takes their edit into the baseline", (t) => {
  const s = sandbox(t);
  s.write("config.yml", YAML.stringify({ bash: { patterns: USER } }));
  assert.equal(s.sn(INSTALL).code, 0);
  edit(s, insertBefore("npm test*", MAKE));
  const re = s.sn(INSTALL);
  assert.equal(re.code, 0, re.out);
  assert.deepEqual(s.manifest().config.patterns.before, { value: [USER[0], MAKE, USER[1]] });
  assert.deepEqual(s.manifest().config.patterns.inserted, OURS);
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(patterns(s), [USER[0], MAKE, USER[1]]);
});

test("a list we created is deleted with its empty parent even after an identical re-install", (t) => {
  const s = sandbox(t);
  s.write("config.yml", "theme:\n  dark: midnight\n");
  assert.equal(s.sn(INSTALL).code, 0);
  assert.equal(s.sn([...INSTALL, "--approval", "always-ask"]).code, 0);
  edit(s, (doc) => doc.setIn(["theme", "light"], "paper"));
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(YAML.parse(s.read("config.yml")), { theme: { dark: "midnight", light: "paper" } });
});

test("after the user moves an allow ahead of our denies, a re-install keeps exactly one copy of each and uninstall removes them", (t) => {
  const s = sandbox(t);
  s.write("config.yml", YAML.stringify({ bash: { patterns: USER } }));
  assert.equal(s.sn(INSTALL).code, 0);
  edit(s, (doc) => {
    const items = doc.getIn(["bash", "patterns"]).items;
    items.unshift(...items.splice(items.findIndex((n) => n.get("match") === "npm test*"), 1));
  });
  const re = s.sn(INSTALL);
  assert.equal(re.code, 0, re.out);
  const list = patterns(s);
  for (const ours of OURS) assert.equal(list.filter((p) => p.match === ours.match && p.approval === ours.approval).length, 1, ours.match);
  assert.ok(list.findIndex((p) => p.match === "*printenv*") < list.findIndex((p) => p.match === "npm test*"));
  assert.equal(s.sn(["verify"]).code, 0);
  edit(s, (doc) => doc.getIn(["bash", "patterns"]).items.push(doc.createNode(MAKE)));
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(patterns(s), [USER[1], USER[0], MAKE]);
});

test("an explicit empty list set by the user after install survives a re-install and uninstall", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  edit(s, (doc) => doc.setIn(["bash", "patterns"], doc.createNode([])));
  assert.equal(s.sn(INSTALL).code, 0);
  assert.deepEqual(s.manifest().config.patterns.before, { value: [] });
  const res = s.sn(["uninstall"]);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(YAML.parse(s.read("config.yml")).bash.patterns, []);
});
