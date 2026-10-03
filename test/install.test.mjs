import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { INSTALL, INTERNAL, MODELS, REPO, seedUserContent, sandbox, snapshot, withoutKeyRefs } from "./helpers.mjs";

const OURS = JSON.parse(fs.readFileSync(path.join(REPO, "config", "deny-patterns.json"), "utf8"));
const DENY = OURS.filter((e) => e.approval === "deny");
const ALLOW = OURS.filter((e) => e.approval === "allow");

test("fresh install then uninstall leaves agent dir and home as they were", (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readlinkSync(path.join(s.agentDir, "skills", "super-nemo")), path.join(REPO, "skills", "super-nemo"));
  assert.equal(fs.readlinkSync(path.join(s.agentDir, "extensions", "super-nemo.js")), path.join(REPO, "extensions", "super-nemo.js"));
  assert.ok(s.manifest().symlinks.includes(path.join(s.agentDir, "extensions", "super-nemo.js")));
  const launcher = path.join(s.home, ".local", "bin", "sn");
  assert.equal(fs.readlinkSync(launcher), path.join(REPO, "sn"));
  assert.ok(s.manifest().symlinks.includes(launcher));
  const viaPath = s.run("sn", ["status"], { PATH: `${path.dirname(launcher)}${path.delimiter}${s.env.PATH}` });
  assert.equal(viaPath.code, 0, viaPath.out);
  assert.match(viaPath.out, /Installed from/);
  assert.equal(fs.readlinkSync(path.join(s.snHome, "current")), REPO);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.tools.approvalMode, "yolo");
  assert.equal(config.tools.approval.eval, "allow");
  assert.equal(s.manifest().choices.evalApproval, "allow");
  assert.equal(s.manifest().config.keys["tools.approval.eval"].ours, "allow");
  const verified = s.sn(["verify"]);
  assert.equal(verified.code, 0, verified.out);
  assert.equal(config.task.isolation.enabled, true);
  assert.equal(config.advisor.syncBacklog, "3");
  assert.deepEqual(config.bash.patterns, [...DENY, ...ALLOW]);
  assert.ok(!config.bash.patterns.some((p) => p.match.includes("git push")));
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("--yes can explicitly keep eval confirmation without changing command approval", (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const installed = s.sn([...INSTALL, "--eval-approval", "prompt", "--approval", "write"]);
  assert.equal(installed.code, 0, installed.out);
  assert.match(installed.out, /Eval approval +prompt/);
  assert.equal(s.manifest().choices.evalApproval, "prompt");
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
  assert.equal(s.sn(["verify"]).code, 0);
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("install creates a missing user bin; uninstall keeps its empty parent directories", (t) => {
  const s = sandbox(t, { localBin: false });
  const bin = path.join(s.home, ".local", "bin");
  assert.equal(fs.existsSync(bin), false);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readlinkSync(path.join(bin, "sn")), path.join(REPO, "sn"));
  const removed = s.sn(["uninstall"]);
  assert.equal(removed.code, 0, removed.out);
  assert.equal(fs.existsSync(path.join(bin, "sn")), false);
  assert.ok(fs.statSync(bin).isDirectory());
  assert.equal(fs.existsSync(s.snHome), false);
});

test("install keeps user content, puts our denies first and allows last, and uninstall restores the exact bytes", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 0, res.out);

  const text = s.read("config.yml");
  assert.match(text, /# my settings/);
  assert.match(text, /# my everyday model/);
  const config = YAML.parse(text);
  assert.equal(config.modelRoles.default, "beta/sol:medium");
  assert.equal(config.modelRoles.smol, "alpha/small");
  assert.equal(config.theme.dark, "midnight");
  assert.deepEqual(config.bash.patterns, [
    ...DENY,
    { match: "*rm -rf /*", approval: "deny" },
    { match: "npm test*", approval: "allow" },
    ...ALLOW,
  ]);
  assert.match(s.read("AGENTS.md"), /^# My rules\n\nAlways answer in English\.\n\n<!-- super-nemo:begin -->\n@~\/\.super-nemo\/current\/blocks\/AGENTS\.md\n<!-- super-nemo:end -->\n$/);
  assert.match(s.read("WATCHDOG.md"), /^Watch for flaky tests\.\n\n<!-- super-nemo:begin -->/);

  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("a user rule for the same command as one of our allow rules still comes first", (t) => {
  const s = sandbox(t);
  s.write("config.yml", "bash:\n  patterns:\n    - match: \"git diff*\"\n      approval: deny\n");
  const res = s.sn(INSTALL);
  assert.equal(res.code, 0, res.out);
  const patterns = YAML.parse(s.read("config.yml")).bash.patterns;
  const first = patterns.findIndex((p) => p.match === "git diff*");
  assert.deepEqual(patterns[first], { match: "git diff*", approval: "deny" });
  assert.ok(patterns.slice(0, first).every((p) => p.approval === "deny"));
});

test("a user entry equal to one of ours is not duplicated and survives uninstall", (t) => {
  const s = sandbox(t);
  s.write("config.yml", "bash:\n  patterns:\n    - match: \"*printenv*\"\n      approval: deny\n");
  assert.equal(s.sn(INSTALL).code, 0);
  const patterns = YAML.parse(s.read("config.yml")).bash.patterns;
  assert.equal(patterns.filter((p) => p.match === "*printenv*").length, 1);
  s.write("AGENTS.md", `${s.read("AGENTS.md")}user line\n`);
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(YAML.parse(s.read("config.yml")).bash.patterns, [{ match: "*printenv*", approval: "deny" }]);
});

test("second identical install changes nothing", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  assert.equal(s.sn(INSTALL).code, 0);
  const first = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Nothing to change/);
  assert.deepEqual(snapshot(s.home), first);
});

test("reinstall of an older manifest adds the sn launcher without changing model choices", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const launcher = path.join(s.home, ".local", "bin", "sn");
  fs.unlinkSync(launcher);
  const prior = s.manifest();
  prior.symlinks = prior.symlinks.filter((p) => p !== launcher);
  fs.writeFileSync(s.manifestPath, JSON.stringify(prior));
  const res = s.sn(["install", "--reuse", "--no-smoke"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.readlinkSync(launcher), path.join(REPO, "sn"));
  assert.deepEqual(s.manifest().choices, prior.choices);
});

test("status reports legacy managed eval allow without a recorded choice", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const legacy = s.manifest();
  delete legacy.choices.evalApproval;
  fs.writeFileSync(s.manifestPath, JSON.stringify(legacy));
  const shown = s.sn(["status"]);
  assert.equal(shown.code, 0, shown.out);
  assert.match(shown.out, /Eval approval +allow +runs eval code without asking/);
});

test("unknown legacy eval ownership cannot replace live allow on --reuse or --yes without explicit replacement", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const prior = s.manifest();
  delete prior.choices.evalApproval;
  delete prior.config.keys["tools.approval.eval"];
  fs.writeFileSync(s.manifestPath, JSON.stringify(prior));
  const before = snapshot(s.home);
  const shown = s.sn(["status"]);
  assert.equal(shown.code, 0, shown.out);
  assert.match(shown.out, /Eval approval +unmanaged +not managed by SUPER-NEMO/);
  for (const args of [["install", "--reuse", "--no-smoke"], INSTALL, [...INSTALL, "--overwrite-drift"], [...INSTALL, "--eval-approval", "prompt"]]) {
    const stopped = s.sn(args);
    assert.equal(stopped.code, 3, stopped.out);
    assert.deepEqual(snapshot(s.home), before);
  }
  const replaced = s.sn([...INSTALL, "--eval-approval", "prompt", "--overwrite-drift"]);
  assert.equal(replaced.code, 0, replaced.out);
  assert.equal(s.manifest().choices.evalApproval, "prompt");
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
});

test("unknown legacy eval ownership cannot silently weaken a user's deny setting", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approval", "eval"], "deny");
  s.write("config.yml", doc.toString());
  const prior = s.manifest();
  delete prior.choices.evalApproval;
  delete prior.config.keys["tools.approval.eval"];
  fs.writeFileSync(s.manifestPath, JSON.stringify(prior));
  const before = snapshot(s.home);
  for (const args of [["install", "--reuse", "--no-smoke"], INSTALL, [...INSTALL, "--overwrite-drift"]]) {
    const stopped = s.sn(args);
    assert.equal(stopped.code, 3, stopped.out);
    assert.deepEqual(snapshot(s.home), before);
  }
  const replaced = s.sn([...INSTALL, "--eval-approval", "prompt", "--overwrite-drift"]);
  assert.equal(replaced.code, 0, replaced.out);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "deny");
});

test("unsupported legacy eval provenance cannot claim ownership or bypass the deny drift gate", (t) => {
  for (const existing of ["deny", "unsupported"]) {
    const s = sandbox(t);
    assert.equal(s.sn(INSTALL).code, 0);
    const doc = YAML.parseDocument(s.read("config.yml"));
    doc.setIn(["tools", "approval", "eval"], existing);
    s.write("config.yml", doc.toString());
    const malformed = s.manifest();
    if (existing === "deny") delete malformed.choices.evalApproval;
    malformed.config.keys["tools.approval.eval"].ours = existing;
    fs.writeFileSync(s.manifestPath, JSON.stringify(malformed));
    const before = snapshot(s.home);
    const shown = s.sn(["status"]);
    assert.equal(shown.code, 0, shown.out);
    assert.match(shown.out, /Eval approval +unmanaged +not managed by SUPER-NEMO/);
    for (const args of [["install", "--reuse", "--no-smoke"], INSTALL, [...INSTALL, "--overwrite-drift"]]) {
      const stopped = s.sn(args);
      assert.equal(stopped.code, 3, stopped.out);
      assert.deepEqual(snapshot(s.home), before);
    }
    const adopted = s.sn([...INSTALL, "--eval-approval", "prompt", "--overwrite-drift"]);
    assert.equal(adopted.code, 0, adopted.out);
    assert.equal(s.manifest().config.keys["tools.approval.eval"].ours, "prompt");
    assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
    assert.equal(s.sn(["uninstall"]).code, 0);
    assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, existing);
  }
});

test("legacy managed eval prompt remains prompt on reuse and --yes; explicit allow migrates and uninstall restores", (t) => {
  const s = sandbox(t);
  const original = "# my approval settings\ntools:\n  approvalMode: write\n  approval:\n    eval: prompt\n";
  s.write("config.yml", original);
  const before = snapshot(s.home);
  assert.equal(s.sn(INSTALL).code, 0);

  // Model an installation made when the managed eval value was prompt.
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.setIn(["tools", "approval", "eval"], "prompt");
  const previousConfig = doc.toString();
  s.write("config.yml", previousConfig);
  const previous = s.manifest();
  delete previous.choices.evalApproval;
  previous.config.keys["tools.approval.eval"].ours = "prompt";
  previous.files.config.postHash = createHash("sha256").update(previousConfig).digest("hex");
  fs.writeFileSync(s.manifestPath, JSON.stringify(previous));
  const shown = s.sn(["status"]);
  assert.equal(shown.code, 0, shown.out);
  assert.match(shown.out, /Eval approval +prompt +asks before running eval code/);

  const retained = s.sn(["install", "--reuse", "--no-smoke"]);
  assert.equal(retained.code, 0, retained.out);
  const config = YAML.parse(s.read("config.yml"));
  assert.equal(config.tools.approvalMode, "write");
  assert.equal(config.tools.approval.eval, "prompt");
  assert.deepEqual(s.manifest().config.keys["tools.approval.eval"], {
    prior: { value: "prompt" },
    ours: "prompt",
  });
  assert.equal(s.manifest().choices.evalApproval, "prompt");
  assert.equal(s.sn([...INSTALL]).code, 0);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "prompt");
  const migrated = s.sn([...INSTALL, "--eval-approval", "allow"]);
  assert.equal(migrated.code, 0, migrated.out);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approval.eval, "allow");
  const verified = s.sn(["verify"]);
  assert.equal(verified.code, 0, verified.out);
  assert.match(verified.out, /^OK Installation OK$/m);

  const allowedConfig = s.read("config.yml");
  s.write("config.yml", previousConfig);
  const drift = s.sn(["verify"]);
  assert.equal(drift.code, 1, drift.out);
  assert.match(drift.out, /config\.yml: tools\.approval\.eval/);
  s.write("config.yml", allowedConfig);
  const removed = s.sn(["uninstall"]);
  assert.equal(removed.code, 0, removed.out);
  assert.equal(s.read("config.yml"), original);
  assert.deepEqual(snapshot(s.home), before);
});

test("reuse records already-allowed eval from an older manifest without overriding user drift", (t) => {
  const s = sandbox(t);
  const original = "tools:\n  approvalMode: write\n  approval:\n    eval: prompt\n";
  s.write("config.yml", original);
  const before = snapshot(s.home);
  assert.equal(s.sn(INSTALL).code, 0);
  const allowedConfig = s.read("config.yml");
  const previous = s.manifest();
  delete previous.choices.evalApproval;
  previous.config.keys["tools.approval.eval"].ours = "prompt";
  fs.writeFileSync(s.manifestPath, JSON.stringify(previous));
  const previousManifest = fs.readFileSync(s.manifestPath, "utf8");

  const doc = YAML.parseDocument(allowedConfig);
  doc.setIn(["tools", "approval", "eval"], "deny");
  const userConfig = doc.toString();
  s.write("config.yml", userConfig);
  const blocked = s.sn(["install", "--reuse", "--no-smoke"]);
  assert.equal(blocked.code, 3, blocked.out);
  assert.match(blocked.out, /tools\.approval\.eval/);
  assert.equal(s.read("config.yml"), userConfig);
  assert.equal(fs.readFileSync(s.manifestPath, "utf8"), previousManifest);

  s.write("config.yml", allowedConfig);
  const migrated = s.sn(["install", "--reuse", "--eval-approval", "allow", "--no-smoke"]);
  assert.equal(migrated.code, 0, migrated.out);
  assert.equal(s.read("config.yml"), allowedConfig);
  assert.deepEqual(s.manifest().config.keys["tools.approval.eval"], {
    prior: { value: "prompt" },
    ours: "allow",
  });
  const verified = s.sn(["verify"]);
  assert.equal(verified.code, 0, verified.out);
  assert.match(verified.out, /^OK Installation OK$/m);

  const installed = snapshot(s.home);
  const rerun = s.sn(["install", "--reuse", "--no-smoke"]);
  assert.equal(rerun.code, 0, rerun.out);
  assert.match(rerun.out, /Nothing to change/);
  assert.deepEqual(snapshot(s.home), installed);
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.equal(s.read("config.yml"), original);
  assert.deepEqual(snapshot(s.home), before);
});

test("dry-run install and dry-run uninstall write nothing", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  const before = snapshot(s.home);
  const dry = s.sn([...INSTALL, "--dry-run", "--verbose"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /set tools\.approvalMode: \(absent\) -> "yolo"/);
  assert.deepEqual(snapshot(s.home), before);

  assert.equal(s.sn(INSTALL).code, 0);
  const installed = snapshot(s.home);
  const plan = s.sn(["uninstall", "--dry-run", "--verbose"]);
  assert.equal(plan.code, 0);
  assert.match(plan.out, /restore .*config\.yml from backup/);
  assert.match(plan.out, /restore your previous settings in ~\/\.omp\/agent\/config\.yml/);
  assert.deepEqual(snapshot(s.home), installed);
});

test("default output is a short plain summary; --verbose adds every file and key", (t) => {
  const s = sandbox(t);
  seedUserContent(s);
  const internal = new RegExp(`${INTERNAL.source}|\\x1b\\[`);
  const dry = s.sn([...INSTALL, "--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.doesNotMatch(dry.out, internal);
  assert.ok(!dry.out.includes(s.home), dry.out);
  assert.match(dry.out, /Main model +sol - medium +writes the code/);
  assert.match(dry.out, /Reviewers +big - high +different provider = better reviews/);
  assert.match(dry.out, /- add 7 agents and 6 skills and 1 extension to OMP \(linked to /);
  assert.match(dry.out, /- update ~\/\.omp\/agent\/config\.yml: model roles, 23 blocked commands, 5 allowed git commands, task settings, tool approval\n/);
  assert.match(dry.out, /- add the SUPER-NEMO block to ~\/\.omp\/agent\/AGENTS\.md\n/);
  assert.match(dry.out, /- add advisor guidance \(WATCHDOG\.md \/ WATCHDOG\.yml\)\n/);
  assert.match(dry.out, /Backups of changed files: ~\/\.super-nemo\/state\/backups\/\S+\n/);
  assert.match(dry.out, /Dry run: nothing was written\. Add --verbose for every file and setting\./);
  assert.match(dry.out, /Add ~\/\.local\/bin to PATH to use the sn command/);
  const verbose = s.sn([...INSTALL, "--dry-run", "--verbose"]);
  assert.match(verbose.out, /set modelRoles\.nemo-review: \(absent\) -> "alpha\/big:high"/);
  assert.match(verbose.out, new RegExp(`link ${s.agentDir}/skills/super-nemo -> `));
  assert.match(verbose.out, new RegExp(`link ${s.agentDir}/extensions/super-nemo.js -> `));
  assert.match(verbose.out, /set task\.agentModelOverrides\.task: \(absent\) -> "@default"/);
  assert.doesNotMatch(verbose.out, /Add --verbose/);

  const res = s.sn(INSTALL);
  assert.equal(res.code, 0, res.out);
  assert.doesNotMatch(res.out, internal);
  assert.ok(!res.out.includes(s.home), res.out);
  assert.match(res.out, /\nOK Linked agents, skills and extensions\nOK Updated OMP config\nOK Updated AGENTS\.md\nOK Added advisor guidance\nOK Checked installation\n/);
  assert.match(res.out, /\nOK SUPER-NEMO is installed\.\n {2}Next: open a NEW omp session in a repo and ask it to change some code\.\n/);
  for (const cmd of [["status"], ["verify"], ["uninstall"]]) {
    const out = s.sn(cmd).out;
    assert.doesNotMatch(out, internal, cmd[0]);
    assert.ok(!out.includes(s.home), `${cmd[0]}: ${out}`);
  }
});

test("an existing regular file at a target aborts before any write", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.agentDir, "agents"));
  fs.writeFileSync(path.join(s.agentDir, "agents", "nemo-qa.md"), "my own agent\n");
  fs.mkdirSync(path.join(s.agentDir, "extensions"));
  fs.writeFileSync(path.join(s.agentDir, "extensions", "super-nemo.js"), "my own extension\n");
  fs.mkdirSync(path.join(s.agentDir, "skills", "super-nemo"), { recursive: true });
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 1);
  assert.match(res.out, /nemo-qa\.md already exists/);
  assert.match(res.out, /skills\/super-nemo already exists/);
  assert.match(res.out, /extensions\/super-nemo\.js already exists/);
  assert.deepEqual(snapshot(s.home), before);
});

test("a symlink at a target that points elsewhere is a conflict", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.agentDir, "skills"));
  fs.symlinkSync(path.join(s.home, "elsewhere"), path.join(s.agentDir, "skills", "nemo-qa-review"));
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 1);
  assert.match(res.out, /nemo-qa-review already exists \(symlink to .*elsewhere\)/);
  assert.deepEqual(snapshot(s.home), before);
});

test("invalid selector or unsupported thinking level exits 2 and writes nothing", (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const cases = [
    [["--impl", "nope/model"], /unknown model selector "nope\/model"/],
    [["--impl", "alpha/big:max"], /thinking level "max" is not supported by alpha\/big; supported: low, medium, high, xhigh/],
    [["--review", "alpha/plain:high"], /not supported by alpha\/plain; supported: none/],
    [["--fast", "beta/nothing"], /--fast: unknown model selector/],
    [["--eval-approval", "deny"], /--eval-approval must be one of/],
    [["--approval", "sometimes"], /--approval must be one of/],
    [["--advisor", "off", "--advisor-critical", "alpha/big"], /cannot be combined/],
  ];
  for (const [flags, message] of cases) {
    const res = s.sn([...INSTALL, ...flags]);
    assert.equal(res.code, 2, `${flags}: ${res.out}`);
    assert.match(res.out, message);
  }
  assert.deepEqual(snapshot(s.home), before);
});

test("without a terminal and without --yes install refuses with exit 2", (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const res = s.sn(["install", "--no-smoke"]);
  assert.equal(res.code, 2);
  assert.match(res.out, /--yes/);
  assert.deepEqual(snapshot(s.home), before);
});

test("advisor off turns the implementers' advisor off and writes no advisor roles", (t) => {
  const s = sandbox(t);
  const res = s.sn([...INSTALL, "--advisor", "off", "--fast", "alpha/small"]);
  assert.equal(res.code, 0, res.out);
  const config = YAML.parse(s.read("config.yml"));
  assert.deepEqual(config.task.agentAdvisor, { "nemo-implementer": "off", "nemo-implementer-critical": "off" });
  assert.equal(config.modelRoles.advisor, undefined);
  assert.equal(config.modelRoles["advisor-critical"], undefined);
  assert.equal(config.modelRoles["nemo-fast"], "alpha/small:low");
  assert.equal(config.task.agentModelOverrides.scout, "@nemo-fast");
  assert.equal(config.task.agentModelOverrides.sonic, "@nemo-fast");
  const omp = spawnSync("omp", ["config", "get", "task.agentAdvisor", "--json"], { cwd: s.home, env: s.env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(omp.stdout).value, { "nemo-implementer": "off", "nemo-implementer-critical": "off" });
});

test("defaults: strongest remote model high, cross-provider review, advisor from implementation model", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const roles = YAML.parse(s.read("config.yml")).modelRoles;
  assert.deepEqual(roles, {
    default: "alpha/big:high",
    "nemo-review": "beta/sol:high",
    advisor: "alpha/big:medium",
    "advisor-critical": "alpha/big:high",
  });
});

test("mixed OMP inventory selects remote roles and YOLO; explicit local roles remain usable", (t) => {
  const s = sandbox(t);
  const raw = JSON.parse(fs.readFileSync(MODELS, "utf8")).models;
  const local = [
    { ...raw[0], provider: "ollama", selector: "ollama/giant", cost: { output: 999 } },
    { ...raw[1], provider: "lm-studio", selector: "lm-studio/small", cost: { output: 0 } },
    { ...raw[0], provider: "llama.cpp", selector: "llama.cpp/giant", cost: { output: 999 } },
  ];
  const inventory = path.join(s.home, "models.json");
  fs.writeFileSync(inventory, JSON.stringify({ models: [...local, ...raw] }));
  const env = { SN_MODELS_JSON: inventory };
  const res = s.sn(INSTALL, env);
  assert.equal(res.code, 0, res.out);
  let config = YAML.parse(s.read("config.yml"));
  assert.equal(config.tools.approvalMode, "yolo");
  assert.deepEqual(config.modelRoles, {
    default: "alpha/big:high", "nemo-review": "beta/sol:high",
    advisor: "alpha/big:medium", "advisor-critical": "alpha/big:high",
  });
  const explicit = s.sn([...INSTALL, "--impl", "ollama/giant", "--fast", "lm-studio/small",
    "--advisor", "ollama/giant", "--advisor-critical", "llama.cpp/giant",
    "--review", "lm-studio/small", "--approval", "write"], env);
  assert.equal(explicit.code, 0, explicit.out);
  config = YAML.parse(s.read("config.yml"));
  assert.equal(config.tools.approvalMode, "write");
  assert.deepEqual(config.modelRoles, {
    default: "ollama/giant:high", "nemo-fast": "lm-studio/small:low",
    advisor: "ollama/giant:medium", "advisor-critical": "llama.cpp/giant:high",
    "nemo-review": "lm-studio/small:high",
  });
  const again = s.sn(INSTALL, env);
  assert.equal(again.code, 0, again.out);
  assert.equal(again.out.includes("Nothing to change"), true, again.out);
  assert.equal(YAML.parse(s.read("config.yml")).tools.approvalMode, "write");
  assert.equal(YAML.parse(s.read("config.yml")).modelRoles.default, "ollama/giant:high");
});

test("local-only inventory fails without a remote provider or explicit --impl, without writing", (t) => {
  const s = sandbox(t);
  const local = JSON.parse(fs.readFileSync(MODELS, "utf8")).models[0];
  const inventory = path.join(s.home, "local-models.json");
  fs.writeFileSync(inventory, JSON.stringify({ models: [{ ...local, provider: "ollama", selector: "ollama/only" }] }));
  const env = { SN_MODELS_JSON: inventory };
  const before = snapshot(s.home);
  const res = s.sn(INSTALL, env);
  assert.equal(res.code, 2, res.out);
  assert.match(res.out, /Only local models.*remote provider.*--impl/);
  assert.deepEqual(snapshot(s.home), before);
  const selected = s.sn([...INSTALL, "--impl", "ollama/only"], env);
  assert.equal(selected.code, 0, selected.out);
  assert.equal(YAML.parse(s.read("config.yml")).modelRoles.default, "ollama/only:high");
});

test("first install retains pre-existing approval settings instead of enabling YOLO", (t) => {
  for (const mode of ["always-ask", "write"]) {
    const s = sandbox(t);
    s.write("config.yml", `tools:\n  approvalMode: ${mode}\n`);
    const res = s.sn(INSTALL);
    assert.equal(res.code, 0, res.out);
    assert.equal(YAML.parse(s.read("config.yml")).tools.approvalMode, mode);
    assert.equal(s.manifest().choices.approval, mode);
  }
});

test("verify passes after install and each skill resolves to the installed copy", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const res = s.sn(["verify"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /^OK Installation OK$/m);
  assert.doesNotMatch(res.out, /returns a different copy/);

  fs.unlinkSync(path.join(s.agentDir, "skills", "nemo-qa-review"));
  const broken = s.sn(["verify"]);
  assert.equal(broken.code, 1);
  assert.match(broken.out, /^x .*skills\/nemo-qa-review is not a symlink/m);
  assert.match(broken.out, /omp read skill:\/\/nemo-qa-review failed/);

  assert.equal(s.sn(INSTALL).code, 0);
  fs.unlinkSync(path.join(s.agentDir, "extensions", "super-nemo.js"));
  const extension = s.sn(["verify"]);
  assert.equal(extension.code, 1);
  assert.match(extension.out, /^x .*extensions\/super-nemo\.js is not a symlink/m);
});

test("verify fails when a user rule is moved in front of our deny rules", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const doc = YAML.parseDocument(s.read("config.yml"));
  doc.getIn(["bash", "patterns"]).items.unshift(doc.createNode({ match: "*", approval: "allow" }));
  s.write("config.yml", doc.toString());
  const res = s.sn(["verify"]);
  assert.equal(res.code, 1);
  assert.match(res.out, /^x Blocked commands: the rule "\*" \(allow\) comes before SUPER-NEMO's deny rules and can override them \(first match wins\) \(config\.yml: bash\.patterns\)$/m);
});

test("verify fails when one of our own allow rules is moved in front of our deny rules", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const doc = YAML.parseDocument(s.read("config.yml"));
  const items = doc.getIn(["bash", "patterns"]).items;
  const i = items.findIndex((n) => n.get("match") === "git diff*");
  items.unshift(...items.splice(i, 1));
  s.write("config.yml", doc.toString());
  const res = s.sn(["verify"]);
  assert.equal(res.code, 1);
  assert.match(res.out, /^x Blocked commands: the rule "git diff\*" \(allow\) comes before SUPER-NEMO's deny rules/m);
});

test("verify fails when omp lists no models", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const empty = path.join(s.home, "no-models.json");
  fs.writeFileSync(empty, '{"models":[]}');
  const res = s.sn(["verify"], { SN_MODELS_JSON: empty });
  assert.equal(res.code, 1);
  assert.match(res.out, /no available models; run `omp login`/);
});

test("verify names an unavailable chosen model and an overridden setting in plain words", (t) => {
  const s = sandbox(t);
  assert.equal(s.sn(INSTALL).code, 0);
  const fewer = path.join(s.home, "fewer-models.json");
  const all = JSON.parse(fs.readFileSync(s.env.SN_MODELS_JSON, "utf8")).models;
  fs.writeFileSync(fewer, JSON.stringify({ models: all.filter((m) => m.selector !== "beta/sol") }));
  const gone = s.sn(["verify"], { SN_MODELS_JSON: fewer });
  assert.equal(gone.code, 1, gone.out);
  assert.match(gone.out, /^x Reviewers: sol - high is not in OMP's model list any more; log in to its provider or pick another model with sn install \(config\.yml: modelRoles\.nemo-review\)$/m);
  assert.doesNotMatch(withoutKeyRefs(gone.out), INTERNAL);

  const bin = path.join(s.home, "bin");
  fs.mkdirSync(bin);
  const real = spawnSync("bash", ["-c", "command -v omp"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "omp"), [
    "#!/bin/bash",
    "if [ \"$1 $2 $3\" = \"config get tools.approvalMode\" ]; then echo '{\"value\":\"write\"}'; exit 0; fi",
    `exec ${JSON.stringify(real)} "$@"`,
  ].join("\n"), { mode: 0o755 });
  const shadowed = s.sn(["verify"], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(shadowed.code, 0, shadowed.out);
  assert.match(shadowed.out, /^! Auto-approve: OMP uses off instead of on; a project config or environment setting overrides it \(config\.yml: tools\.approvalMode\)$/m);
  assert.doesNotMatch(withoutKeyRefs(shadowed.out), INTERNAL);
});

test("uninstall says it restores a SUPER-NEMO block that was there before install", (t) => {
  const s = sandbox(t);
  const old = "<!-- super-nemo:begin -->\nmy older block\n<!-- super-nemo:end -->\n";
  s.write("AGENTS.md", `# mine\n\n${old}`);
  s.write("WATCHDOG.md", old);
  const before = snapshot(s.home);
  assert.equal(s.sn(INSTALL).code, 0);
  const dry = s.sn(["uninstall", "--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /^ {2}- restore your previous SUPER-NEMO block in ~\/\.omp\/agent\/AGENTS\.md$/m);
  assert.match(dry.out, /^ {2}- restore your previous SUPER-NEMO block in ~\/\.omp\/agent\/WATCHDOG\.md$/m);
  assert.match(dry.out, /^ {2}- remove advisor guidance \(WATCHDOG\.yml\)$/m);
  assert.doesNotMatch(dry.out, /remove the SUPER-NEMO block/);
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("an existing config.yaml is edited in place and never shadowed by a new config.yml", (t) => {
  const s = sandbox(t);
  s.write("config.yaml", "theme:\n  dark: midnight\n");
  const original = s.read("config.yaml");
  assert.equal(s.sn(INSTALL).code, 0);
  assert.ok(!fs.existsSync(s.file("config.yml")));
  assert.equal(YAML.parse(s.read("config.yaml")).tools.approvalMode, "yolo");
  assert.equal(s.sn(["uninstall"]).code, 0);
  assert.equal(s.read("config.yaml"), original);
});

test("both config.yml and config.yaml present aborts", (t) => {
  const s = sandbox(t);
  s.write("config.yml", "a: 1\n");
  s.write("config.yaml", "b: 2\n");
  const before = snapshot(s.home);
  const res = s.sn(INSTALL);
  assert.equal(res.code, 1);
  assert.match(res.out, /both .*config\.yml and .*config\.yaml exist/);
  assert.deepEqual(snapshot(s.home), before);
});

test("--name renames it in AGENTS.md and status, survives --reuse, can go back to nemo, and uninstall restores everything", (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const res = s.sn([...INSTALL, "--name", "Jake"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /SUPER-JAKE is installed\./);
  assert.equal(s.manifest().choices.name, "jake");
  const agents = s.read("AGENTS.md");
  assert.match(agents, /^<!-- super-nemo:begin -->\n@~\/\.super-nemo\/current\/blocks\/AGENTS\.md\n\nHere SUPER-NEMO is called SUPER-JAKE; /);
  assert.match(agents, /`super-jake critical:` mean the same as the matching `super-nemo` prefixes/);
  assert.match(s.sn(["status"]).out, /Name +SUPER-JAKE +start a message with super-jake: to call it/);
  assert.equal(s.sn(["verify"]).code, 0);

  const reuse = s.sn(["install", "--reuse", "--no-smoke"]);
  assert.equal(reuse.code, 0, reuse.out);
  assert.match(reuse.out, /Nothing to change/);
  assert.match(reuse.out, /SUPER-JAKE is installed\./);
  assert.equal(s.read("AGENTS.md"), agents);

  const keep = s.sn(INSTALL);
  assert.equal(keep.code, 0, keep.out);
  assert.equal(s.manifest().choices.name, "jake");

  const back = s.sn([...INSTALL, "--name", "nemo"]);
  assert.equal(back.code, 0, back.out);
  assert.equal(s.read("AGENTS.md"), "<!-- super-nemo:begin -->\n@~/.super-nemo/current/blocks/AGENTS.md\n<!-- super-nemo:end -->\n");
  assert.match(back.out, /SUPER-NEMO is installed\./);

  assert.equal(s.sn([...INSTALL, "--name", "jake"]).code, 0);
  const removed = s.sn(["uninstall"]);
  assert.equal(removed.code, 0, removed.out);
  assert.deepEqual(snapshot(s.home), before);
});

test("an invalid --name is refused before anything is written", (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const res = s.sn([...INSTALL, "--name", "jake doe"]);
  assert.equal(res.code, 2, res.out);
  assert.match(res.out, /--name must be a word of lowercase letters/);
  assert.deepEqual(snapshot(s.home), before);
});
