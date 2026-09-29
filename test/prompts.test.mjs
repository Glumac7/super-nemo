import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { desiredKeys } from "../lib/context.mjs";
import { askChoices, computeDefaults } from "../lib/install.mjs";
import { loadModels } from "../lib/models.mjs";
import { MODELS } from "./helpers.mjs";

const RAW = JSON.parse(fs.readFileSync(MODELS, "utf8")).models;
const models = RAW.map((m) => ({
  provider: m.provider, selector: m.selector, name: m.name, reasoning: m.reasoning, thinking: m.thinking, costOutput: m.cost.output,
}));

function scripted(answers) {
  const asked = [];
  const said = [];
  return {
    asked,
    said,
    ask: async (q) => {
      asked.push(q);
      assert.ok(answers.length, `unexpected question: ${q}`);
      return answers.shift();
    },
    say: (text) => said.push(text),
    remaining: () => answers.length,
  };
}

const fresh = () => computeDefaults(models, YAML.parseDocument(""), null, {});
const menu = (said, title) => {
  const start = said.findIndex((l) => l.startsWith(title));
  assert.ok(start >= 0, `no ${title} menu in:\n${said.join("\n")}`);
  const end = said.findIndex((l, i) => i > start && !l.startsWith("  "));
  return said.slice(start + 1, end < 0 ? undefined : end);
};

test("pressing Enter at the setup question keeps the suggested setup with one question", async () => {
  const d = fresh();
  const p = scripted([""]);
  const choices = await askChoices(p, models, d);
  assert.equal(p.remaining(), 0);
  assert.deepEqual(p.asked, ["Use this setup? [Y/n/c=change] "]);
  assert.deepEqual(choices, {
    impl: "alpha/big:high", fast: null, advisor: "alpha/big:medium", advisorCritical: "alpha/big:high", review: "beta/sol:high", approval: "yolo",
  });
  const shown = p.said.join("\n");
  assert.match(shown, /Suggested setup/);
  assert.match(shown, /Main model +big - high/);
  assert.match(shown, /Cheap model +same as main/);
  assert.match(shown, /Advisor +big - medium +watches the coder \(critical work: high\)/);
  assert.match(shown, /Auto-approve +on +runs every command without asking/);
  assert.doesNotMatch(shown, /modelRoles|@default|nemo-review/);
});

test("answering n at the setup question returns no choices", async () => {
  const p = scripted(["n"]);
  assert.equal(await askChoices(p, models, fresh()), null);
});

test("change flow: other model and thinking, cheap = same as main, advisor off skips the critical question", async () => {
  const p = scripted(["c", "4", "2", "1", "1", "1", "", "y", ""]);
  const choices = await askChoices(p, models, fresh());
  assert.equal(p.remaining(), 0);
  assert.deepEqual(choices, { impl: "beta/sol:medium", fast: null, advisor: null, advisorCritical: null, review: "alpha/big:high", approval: "yolo" });
  assert.ok(!p.said.some((l) => l.startsWith("Advisor for critical work")));
  assert.equal(p.asked.at(-1), "Use this setup? [Y/n/c] ");
  assert.ok(p.said.some((l) => /Your setup/.test(l)));
  const keys = desiredKeys(choices);
  assert.equal(keys["modelRoles.nemo-fast"], undefined);
  assert.equal(keys["task.agentModelOverrides.scout"], "@default");
  assert.equal(keys["modelRoles.advisor"], undefined);
  assert.equal(keys["modelRoles.advisor-critical"], undefined);
  assert.equal(keys["task.agentAdvisor.nemo-implementer"], "off");
  assert.equal(keys["tools.approvalMode"], "yolo");
});

test("change flow lists every model across providers once, marks the suggestion and preselects it", async () => {
  const p = scripted(["c", "", "", "3", "", "5", "", "", "", "", "", "", ""]);
  const choices = await askChoices(p, models, fresh());
  assert.equal(p.remaining(), 0);
  assert.deepEqual(choices, {
    impl: "alpha/big:high", fast: "alpha/small:low", advisor: "beta/sol:medium", advisorCritical: "beta/sol:high", review: "beta/sol:high", approval: "yolo",
  });
  assert.deepEqual(menu(p.said, "Main model"), ["  1) big - alpha  (suggested)", "  2) small - alpha", "  3) plain - alpha", "  4) sol - beta"]);
  assert.deepEqual(menu(p.said, "Cheap model"), ["  1) same as main  (suggested)", "  2) big - alpha", "  3) small - alpha  (cheapest)", "  4) plain - alpha", "  5) sol - beta"]);
  assert.deepEqual(menu(p.said, "Thinking for small"), ["  1) minimal", "  2) low  (suggested)", "  3) medium", "  4) high"]);
  assert.deepEqual(menu(p.said, "Advisor for critical work").at(3), "  4) sol - beta  (suggested)");
  assert.ok(p.asked.includes("Auto-approve every command? (yes = runs commands that change things without asking) [Y/n] "));
});

test("a model without thinking levels gets no suffix and no thinking question; bad input re-asks with a hint", async () => {
  const p = scripted(["maybe", "c", "9", "x", "3", "", "", "", "", "", "", "", "", ""]);
  const choices = await askChoices(p, models, fresh());
  assert.equal(p.remaining(), 0);
  assert.equal(choices.impl, "alpha/plain");
  assert.ok(p.said.includes("Please answer y (use it), n (cancel) or c (change it)."));
  assert.equal(p.said.filter((l) => l === "Enter a number from 1 to 4, or press Enter for 1.").length, 2);
  assert.ok(!p.said.some((l) => l === "Thinking for plain"));
});

test("a re-install shows the current setup and marks current values", async () => {
  const doc = YAML.parseDocument("modelRoles:\n  default: alpha/big:medium\n  nemo-review: alpha/small:high\n");
  const d = computeDefaults(models, doc, { choices: { approval: "always-ask" } }, {});
  assert.equal(d.impl, "alpha/big:medium");
  assert.equal(d.review, "alpha/small:high");
  const p = scripted(["c", "", "", "", "", "", "", "", "", "", "", ""]);
  const choices = await askChoices(p, models, d);
  assert.equal(p.remaining(), 0);
  assert.match(p.said[0], /Current setup/);
  assert.match(p.said[0], /Reviewers +small - high +same provider as the main model/);
  assert.match(p.said[0], /Auto-approve +off +asks before every command/);
  assert.deepEqual(menu(p.said, "Thinking for big").at(1), "  2) medium  (current)");
  assert.deepEqual(choices, {
    impl: "alpha/big:medium", fast: null, advisor: "alpha/big:medium", advisorCritical: "alpha/big:high", review: "alpha/small:high", approval: "always-ask",
  });
});

test("local providers never win cloud suggestions, but explicit and recorded local roles stay selectable", async () => {
  const local = [
    { ...models[0], provider: "ollama", selector: "ollama/giant", costOutput: 1000 },
    { ...models[1], provider: "lm-studio", selector: "lm-studio/cheap", costOutput: 0 },
    { ...models[0], provider: "llama.cpp", selector: "llama.cpp/large", costOutput: 500 },
  ];
  const inventory = [...local, ...models];
  const defaults = computeDefaults(inventory, YAML.parseDocument(""), null, {});
  assert.deepEqual(
    [defaults.impl, defaults.fast, defaults.advisor, defaults.advisorCritical, defaults.review, defaults.approval],
    ["alpha/big:high", null, "alpha/big:medium", "alpha/big:high", "beta/sol:high", "yolo"],
  );
  const p = scripted([""]);
  assert.deepEqual(await askChoices(p, inventory, defaults), {
    impl: defaults.impl, fast: null, advisor: defaults.advisor, advisorCritical: defaults.advisorCritical,
    review: defaults.review, approval: "yolo",
  });
  assert.deepEqual(p.asked, ["Use this setup? [Y/n/c=change] "]);

  const selected = computeDefaults(inventory, YAML.parseDocument(""), null, {
    impl: "ollama/giant", fast: "lm-studio/cheap", advisor: "ollama/giant",
    "advisor-critical": "llama.cpp/large", review: "lm-studio/cheap", approval: "write",
  });
  assert.deepEqual([selected.impl, selected.fast, selected.advisor, selected.advisorCritical, selected.review, selected.approval],
    ["ollama/giant:high", "lm-studio/cheap:low", "ollama/giant:medium", "llama.cpp/large:high", "lm-studio/cheap:high", "write"]);

  const currentLocalMain = computeDefaults(inventory, YAML.parseDocument("modelRoles:\n  default: ollama/giant:medium\n"), null, {});
  assert.deepEqual([currentLocalMain.impl, currentLocalMain.fast, currentLocalMain.advisor, currentLocalMain.advisorCritical, currentLocalMain.review],
    ["ollama/giant:medium", "alpha/small:low", "alpha/big:medium", "alpha/big:high", "alpha/big:high"]);

  const existing = YAML.parseDocument("modelRoles:\n  default: ollama/giant:medium\n  nemo-fast: lm-studio/cheap:low\n  advisor: ollama/giant:low\n  advisor-critical: ollama/giant:xhigh\n  nemo-review: llama.cpp/large:high\n");
  const kept = computeDefaults(inventory, existing, { choices: { approval: "always-ask" } }, {});
  assert.deepEqual([kept.impl, kept.fast, kept.advisor, kept.advisorCritical, kept.review, kept.approval],
    ["ollama/giant:medium", "lm-studio/cheap:low", "ollama/giant:low", "ollama/giant:xhigh", "llama.cpp/large:high", "always-ask"]);
});

test("changing to local models interactively leaves fast and critical suggestions remote", async () => {
  const local = [
    { ...models[0], provider: "ollama", selector: "ollama/giant", costOutput: 1000 },
    { ...models[1], provider: "lm-studio", selector: "lm-studio/cheap", costOutput: 0 },
  ];
  const inventory = [...local, ...models];
  const p = scripted(["c", "1", "", "", "", "3", "", "", "", "", "", "", ""]);
  const choices = await askChoices(p, inventory, computeDefaults(inventory, YAML.parseDocument(""), null, {}));
  assert.equal(p.remaining(), 0);
  assert.deepEqual([choices.impl, choices.fast, choices.advisor, choices.advisorCritical, choices.review, choices.approval],
    ["ollama/giant:high", "alpha/small:low", "lm-studio/cheap:medium", "alpha/big:high", "beta/sol:high", "yolo"]);
  assert.ok(menu(p.said, "Cheap model").includes("  5) small - alpha  (suggested)"));
  assert.ok(menu(p.said, "Advisor for critical work").includes("  3) big - alpha  (suggested)"));
  assert.ok(menu(p.said, "Main model").includes("  1) giant - ollama"));

  const doc = YAML.parseDocument("modelRoles:\n  nemo-fast: lm-studio/cheap:low\n");
  const current = computeDefaults(inventory, doc, { choices: { approval: "write" } }, {});
  const keep = scripted(["c", "1", "", "", "", "", "", "", "", "", "", "", ""]);
  const changed = await askChoices(keep, inventory, current);
  assert.equal(keep.remaining(), 0);
  assert.equal(changed.fast, "lm-studio/cheap:low");
  assert.ok(menu(keep.said, "Cheap model").includes("  3) cheap - lm-studio  (current)"));

  const sameAsMain = computeDefaults(inventory, YAML.parseDocument(""), { choices: { fast: null, approval: "write" } }, {});
  const recorded = scripted(["c", "1", ...Array(10).fill("")]);
  const retained = await askChoices(recorded, inventory, sameAsMain);
  assert.equal(recorded.remaining(), 0);
  assert.equal(retained.fast, null);
  assert.ok(menu(recorded.said, "Cheap model").includes("  1) same as main  (current)"));

  const twoChanges = scripted(["c", ...Array(10).fill(""), "c", "1", ...Array(11).fill("")]);
  const secondPass = await askChoices(twoChanges, inventory, computeDefaults(inventory, YAML.parseDocument(""), null, {}));
  assert.equal(twoChanges.remaining(), 0);
  assert.equal(secondPass.impl, "ollama/giant:high");
  assert.equal(secondPass.fast, "alpha/small:low");
  assert.ok(twoChanges.said.includes("  5) small - alpha  (suggested)"));
});

test("local-only inventory requires an explicit model choice before suggesting any defaults", () => {
  const local = [{ ...models[0], provider: "ollama", selector: "ollama/only" }];
  assert.throws(() => computeDefaults(local, YAML.parseDocument(""), null, {}), /Only local models.*remote provider.*--impl/);
  const existing = YAML.parseDocument("modelRoles:\n  default: ollama/only:medium\n");
  assert.equal(computeDefaults(local, existing, null, {}).impl, "ollama/only:medium");
  assert.equal(computeDefaults(local, existing, { choices: { impl: "ollama/only:medium" } }, {}).impl, "ollama/only:medium");
  const selected = computeDefaults(local, YAML.parseDocument(""), null, { impl: "ollama/only" });
  assert.equal(selected.impl, "ollama/only:high");
  assert.equal(selected.advisor, "ollama/only:medium");
  assert.equal(selected.review, "ollama/only:high");
});

test("an existing approval choice beats the new YOLO fallback", () => {
  const doc = YAML.parseDocument("tools:\n  approvalMode: always-ask\n");
  assert.equal(computeDefaults(models, doc, null, {}).approval, "always-ask");
  assert.equal(computeDefaults(models, doc, null, { approval: "write" }).approval, "write");
  assert.equal(computeDefaults(models, doc, { choices: { approval: "write" } }, {}).approval, "write");
});

test("a model with missing or null output cost is never taken as the cheapest fast model", async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sn-models-")), "models.json");
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const extra = [
    { provider: "alpha", kind: "chat", selector: "alpha/null-cost", reasoning: true, thinking: ["low"], cost: { output: null } },
    { provider: "alpha", kind: "chat", selector: "alpha/no-cost", reasoning: true, thinking: ["low"] },
  ];
  fs.writeFileSync(file, JSON.stringify({ models: [...RAW, ...extra] }));
  process.env.SN_MODELS_JSON = file;
  t.after(() => delete process.env.SN_MODELS_JSON);
  const loaded = await loadModels({});
  const p = scripted(["c", "", "", "", "", "", "", "", "", "", "", ""]);
  await askChoices(p, loaded, computeDefaults(loaded, YAML.parseDocument(""), null, {}));
  assert.equal(p.remaining(), 0);
  assert.deepEqual(menu(p.said, "Cheap model").filter((l) => l.includes("(cheapest)")), ["  3) small - alpha  (cheapest)"]);
});
