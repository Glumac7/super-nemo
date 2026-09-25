import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { INSTALL, INTERNAL, REPO, sandbox, snapshot, underPty, withoutKeyRefs } from "./helpers.mjs";

const SN = JSON.stringify(path.join(REPO, "sn"));
const SGR = /\x1b\[[0-9;]*m/;
const color = (env) => {
  const out = { ...env, TERM: "xterm-256color" };
  delete out.NO_COLOR;
  return out;
};

test("a fresh interactive install that accepts every default asks exactly three questions and writes what --yes writes", async (t) => {
  const s = sandbox(t);
  const { code, out, questions } = await underPty(`${SN} install`, color(s.env), () => "");
  assert.equal(code, 0, out);
  assert.equal(questions.length, 3, questions.join("\n---\n"));
  assert.match(questions[0], /Suggested setup[\s\S]*Use this setup\? \[Y\/n\/c=change\] $/);
  assert.match(questions[1], /This will[\s\S]*Apply\? \[Y\/n\] $/);
  assert.match(questions[2], /Checked installation[\s\S]*Run a quick live test\? OMP does two tiny tasks in a throwaway folder .*\[y\/N\] $/);
  assert.match(out, SGR);
  assert.match(out, /✓\x1b\[0m Linked agents and skills/);
  assert.match(out, /Test it later: .*sn verify --smoke\r?\n/);
  assert.match(out, /✓\x1b\[0m SUPER-NEMO is installed\.\r?\n {2}Next: open a NEW omp session in a repo and ask it to change some code\.\r?\n {2}Update: {4}.*sn update\r?\n {2}Uninstall: .*sn uninstall/);

  const y = sandbox(t);
  assert.equal(y.sn(INSTALL).code, 0);
  assert.deepEqual(snapshot(s.agentDir), snapshot(y.agentDir));
  const pick = (m) => ({ choices: m.choices, keys: m.config.keys, patterns: m.config.patterns, symlinks: m.symlinks.map((p) => path.relative(m.agentDir, p)) });
  assert.deepEqual(pick(s.manifest()), pick(y.manifest()));
});

test("NO_COLOR output has no color codes, TERM=dumb output has no escape sequences at all, and n at the setup question changes nothing", async (t) => {
  for (const [plain, forbidden] of [[{ NO_COLOR: "1" }, SGR], [{ TERM: "dumb" }, /\x1b\[/]]) {
    const s = sandbox(t);
    const before = snapshot(s.home);
    const { code, out, questions } = await underPty(`${SN} install`, { ...color(s.env), ...plain }, () => "n");
    assert.equal(code, 1, out);
    assert.equal(questions.length, 1);
    assert.doesNotMatch(out, forbidden);
    assert.match(out, /Main model {5}big - high {5}writes the code/);
    assert.match(out, /Nothing was changed\./);
    assert.deepEqual(snapshot(s.home), before);
  }
});

test("Ctrl+D and Ctrl+C at a question cancel without changes, also with TERM=dumb", async (t) => {
  for (const term of ["xterm-256color", "dumb"]) {
    for (const [key, exit] of [["\x04", 1], ["\x03", 130]]) {
      const s = sandbox(t);
      const before = snapshot(s.home);
      const { code, out } = await underPty(`${SN} install`, { ...color(s.env), TERM: term }, () => key);
      assert.equal(code, exit, `${term} ${JSON.stringify(key)}: ${out}`);
      assert.match(out, /Cancelled\. Nothing was changed\./);
      assert.deepEqual(snapshot(s.home), before);
    }
  }
});

test("a re-install asks about each changed setting in plain words and lists the kept ones in the summary", async (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["task", "agentModelOverrides", "scout"], "@nemo-review");
  s.write("config.yml", doc.toString());
  const { out, questions } = await underPty(`${SN} install`, { ...s.env, NO_COLOR: "1" }, () => "");
  assert.match(questions[0], /Current setup[\s\S]*Use this setup\? \[Y\/n\/c=change\] $/);
  assert.match(questions[1], /Model for scout: you changed this to Reviewers model since install; replace it with same as main\? \(config\.yml: task\.agentModelOverrides\.scout\) \[y\/N\] $/);
  assert.match(out, /\r\n {2}! Model for scout: you changed this to Reviewers model; kept it \(config\.yml: task\.agentModelOverrides\.scout\)\r\n/);
  assert.equal(YAML.parse(s.read("config.yml")).task.agentModelOverrides.scout, "@nemo-review");
  assert.doesNotMatch(withoutKeyRefs(questions.slice(0, 2).join("")), INTERNAL);
});

test("interactive uninstall asks first; the default answer keeps everything", async (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  assert.equal(s.sn(INSTALL).code, 0);
  const installed = snapshot(s.home);
  const kept = await underPty(`${SN} uninstall`, color(s.env), () => "");
  assert.equal(kept.code, 1, kept.out);
  assert.match(kept.questions[0], /This will[\s\S]*remove 7 agents and 6 skills from OMP[\s\S]*Remove SUPER-NEMO\? \[y\/N\] $/);
  assert.match(kept.out, /Nothing was changed\./);
  assert.deepEqual(snapshot(s.home), installed);
  const removed = await underPty(`${SN} uninstall`, color(s.env), () => "y");
  assert.equal(removed.code, 0, removed.out);
  assert.match(removed.out, /✓\x1b\[0m SUPER-NEMO removed\./);
  assert.deepEqual(snapshot(s.home), before);
});
