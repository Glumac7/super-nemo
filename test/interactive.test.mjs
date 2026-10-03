import assert from "node:assert/strict";
import fs from "node:fs";
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

test("a fresh interactive install accepts eval consent explicitly before Apply and writes what --yes writes", async (t) => {
  const s = sandbox(t);
  const { code, out, questions } = await underPty(`${SN} install`, color(s.env), () => "");
  assert.equal(code, 0, out);
  assert.equal(questions.length, 5, questions.join("\n---\n"));
  assert.match(questions[0], /SUPER-NEMO setup[\s\S]*What should it be called\? super-<name> \[nemo\]: $/);
  assert.match(questions[1], /Suggested setup[\s\S]*Use this setup\? \[Y\/n\/c=change\] $/);
  assert.match(questions[2], /Run eval code without asking for confirmation\?.*\[Y\/n\] $/);
  assert.match(questions[3], /Eval approval +allow[\s\S]*This will[\s\S]*Apply\? \[Y\/n\] $/);
  assert.match(questions[4], /Checked installation[\s\S]*Run a quick live test\? OMP does two tiny tasks in a throwaway folder .*\[y\/N\] $/);
  assert.match(out, SGR);
  assert.match(out, /✓\x1b\[0m Linked agents, skills and extensions/);
  assert.match(out, /Test it later: .*sn verify --smoke\r?\n/);
  assert.match(out, /✓\x1b\[0m SUPER-NEMO is installed\.\r?\n {2}Next: open a NEW omp session in a repo and ask it to change some code\.\r?\n {2}Update: {4}.*sn update\r?\n {2}Uninstall: .*sn uninstall/);

  const y = sandbox(t);
  assert.equal(y.sn(INSTALL).code, 0);
  assert.deepEqual(snapshot(s.agentDir), snapshot(y.agentDir));
  const pick = (m) => ({ choices: m.choices, keys: m.config.keys, patterns: m.config.patterns, symlinks: m.symlinks.map((p) => path.relative(m.agentDir, p)) });
  assert.deepEqual(pick(s.manifest()), pick(y.manifest()));
});

test("declining eval consent uses prompt and cancelling at Apply leaves no installation", async (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const stopped = await underPty(`${SN} install`, { ...s.env, NO_COLOR: "1" },
    (q) => /Run eval code without asking/.test(q) ? "n" : /Apply\?/.test(q) ? "n" : "");
  assert.equal(stopped.code, 1, stopped.out);
  assert.match(stopped.out, /Eval approval +prompt/);
  assert.deepEqual(snapshot(s.home), before);
  const accepted = await underPty(`${SN} install`, { ...s.env, NO_COLOR: "1" },
    (q) => /Run eval code without asking/.test(q) ? "n" : "");
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(s.manifest().choices.evalApproval, "prompt");
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
  assert.equal(s.sn(["verify"]).code, 0);
});

test("NO_COLOR output has no color codes, TERM=dumb output has no escape sequences at all, and n at the setup question changes nothing", async (t) => {
  for (const [plain, forbidden] of [[{ NO_COLOR: "1" }, SGR], [{ TERM: "dumb" }, /\x1b\[/]]) {
    const s = sandbox(t);
    const before = snapshot(s.home);
    const { code, out, questions } = await underPty(`${SN} install`, { ...color(s.env), ...plain }, (q) => (/super-<name>/.test(q) ? "" : "n"));
    assert.equal(code, 1, out);
    assert.equal(questions.length, 2);
    assert.doesNotMatch(out, forbidden);
    assert.match(out, /Main model +big - high +writes the code/);
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
  assert.match(questions[0], /What should it be called\? super-<name> \[nemo\]: $/);
  assert.match(questions[1], /Current setup[\s\S]*Use this setup\? \[Y\/n\/c=change\] $/);
  assert.match(questions[2], /Run eval code without asking for confirmation\?.*\[Y\/n\] $/);
  assert.match(questions[3], /Model for scout: you changed this to Reviewers model since install; replace it with same as main\? \(config\.yml: task\.agentModelOverrides\.scout\) \[y\/N\] $/);
  assert.match(out, /\r\n {2}! Model for scout: you changed this to Reviewers model; kept it \(config\.yml: task\.agentModelOverrides\.scout\)\r\n/);
  assert.equal(YAML.parse(s.read("config.yml")).task.agentModelOverrides.scout, "@nemo-review");
  assert.doesNotMatch(withoutKeyRefs(questions.slice(0, 3).join("")), INTERNAL);
});

test("reinstall preserves an unowned eval deny by default and only replaces it after explicit confirmation", async (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const legacy = s.manifest();
  delete legacy.choices.evalApproval;
  delete legacy.config.keys["tools.approval.eval"];
  fs.writeFileSync(s.manifestPath, JSON.stringify(legacy));

  const kept = await underPty(`${SN} install`, { ...s.env, NO_COLOR: "1" }, () => "");
  assert.equal(kept.code, 0, kept.out);
  assert.match(kept.questions.find((q) => /not previously managed; let SUPER-NEMO manage it/.test(q)) ?? "",
    /Eval approval: is deny and was not previously managed; let SUPER-NEMO manage it as prompt\?.*\[y\/N\] $/);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
  assert.equal(Object.hasOwn(s.manifest().config.keys, "tools.approval.eval"), false);
  assert.match(s.sn(["status"]).out, /Eval approval +unmanaged +not managed by SUPER-NEMO/);
  assert.equal(s.sn(["install", "--reuse", "--no-smoke"]).code, 3);

  const confirmed = await underPty(`${SN} install`, { ...s.env, NO_COLOR: "1" },
    (q) => /not previously managed; let SUPER-NEMO manage it/.test(q) ? "y" : "");
  assert.equal(confirmed.code, 0, confirmed.out);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
  assert.equal(s.manifest().config.keys["tools.approval.eval"].ours, "prompt");
});

test("a legacy live prompt remains unmanaged until its owner consents to adopting it", async (t) => {
  const s = sandbox(t);
  assert.equal(s.sn([...INSTALL, "--eval-approval", "prompt"]).code, 0);
  const legacy = s.manifest();
  delete legacy.choices.evalApproval;
  delete legacy.config.keys["tools.approval.eval"];
  fs.writeFileSync(s.manifestPath, JSON.stringify(legacy));
  const before = snapshot(s.home);
  for (const args of [["install", "--reuse", "--no-smoke"], INSTALL,
    [...INSTALL, "--eval-approval", "prompt"], [...INSTALL, "--overwrite-drift"]]) {
    const stopped = s.sn(args);
    assert.equal(stopped.code, 3, stopped.out);
    assert.deepEqual(snapshot(s.home), before);
  }

  const kept = await underPty(`${SN} install`, { ...s.env, NO_COLOR: "1" }, () => "");
  assert.equal(kept.code, 0, kept.out);
  assert.match(kept.questions.find((q) => /not previously managed; let SUPER-NEMO manage it/.test(q)) ?? "",
    /Eval approval: is prompt and was not previously managed; let SUPER-NEMO manage it as prompt\?.*\[y\/N\] $/);
  assert.equal(s.manifest().choices.evalApproval, "prompt");
  assert.equal(Object.hasOwn(s.manifest().config.keys, "tools.approval.eval"), false);
  assert.match(s.sn(["status"]).out, /Eval approval +unmanaged +not managed by SUPER-NEMO/);
  assert.equal(s.sn(["install", "--reuse", "--no-smoke"]).code, 3);

  const accepted = s.sn([...INSTALL, "--eval-approval", "prompt", "--overwrite-drift"]);
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(s.manifest().config.keys["tools.approval.eval"].ours, "prompt");
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
});

test("malformed eval ownership cannot skip the interactive deny confirmation", async (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const malformed = s.manifest();
  malformed.config.keys["tools.approval.eval"].ours = "deny";
  fs.writeFileSync(s.manifestPath, JSON.stringify(malformed));

  const kept = await underPty(`${SN} install`, { ...s.env, NO_COLOR: "1" }, () => "");
  assert.equal(kept.code, 0, kept.out);
  assert.match(kept.questions.find((q) => /not previously managed; let SUPER-NEMO manage it/.test(q)) ?? "",
    /Eval approval: is deny and was not previously managed; let SUPER-NEMO manage it as allow\?.*\[y\/N\] $/);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
  assert.equal(Object.hasOwn(s.manifest().config.keys, "tools.approval.eval"), false);
  assert.match(s.sn(["status"]).out, /Eval approval +unmanaged +not managed by SUPER-NEMO/);

  const adopted = await underPty(`${SN} install`, { ...s.env, NO_COLOR: "1" },
    (q) => /not previously managed; let SUPER-NEMO manage it/.test(q) ? "y" : "");
  assert.equal(adopted.code, 0, adopted.out);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "allow");
  assert.equal(s.manifest().config.keys["tools.approval.eval"].ours, "allow");
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
});

test("interactive uninstall asks first; the default answer keeps everything", async (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  assert.equal(s.sn(INSTALL).code, 0);
  const installed = snapshot(s.home);
  const kept = await underPty(`${SN} uninstall`, color(s.env), () => "");
  assert.equal(kept.code, 1, kept.out);
  assert.match(kept.questions[0], /This will[\s\S]*remove 7 agents and 6 skills and 1 extension from OMP[\s\S]*Remove SUPER-NEMO\? \[y\/N\] $/);
  assert.match(kept.out, /Nothing was changed\./);
  assert.deepEqual(snapshot(s.home), installed);
  const removed = await underPty(`${SN} uninstall`, color(s.env), () => "y");
  assert.equal(removed.code, 0, removed.out);
  assert.match(removed.out, /✓\x1b\[0m SUPER-NEMO removed\./);
  assert.deepEqual(snapshot(s.home), before);
});

test("typing a name at the first question renames it", async (t) => {
  const s = sandbox(t);
  const { code, out, questions } = await underPty(`${SN} install`, { ...s.env, NO_COLOR: "1" }, (q) => (/super-<name>/.test(q) ? "jake" : ""));
  assert.equal(code, 0, out);
  assert.match(questions[1], /Name +SUPER-JAKE +start a message with super-jake: to call it/);
  assert.match(out, /SUPER-JAKE is installed\./);
  assert.equal(s.manifest().choices.name, "jake");
  assert.match(s.read("AGENTS.md"), /called SUPER-JAKE/);
});
