import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
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

test("turning the advisor off skips the CRITICAL advisor question", async () => {
  const d = computeDefaults(models, YAML.parseDocument(""), null, {});
  const p = scripted(["", "", "", "n", "n", "", "", "", "n"]);
  const choices = await askChoices(p, models, d);
  assert.equal(p.remaining(), 0);
  assert.deepEqual(choices, {
    impl: "alpha/big:high", fast: null, advisor: null, advisorCritical: null, review: "beta/sol:high", approval: "write",
  });
  assert.ok(!p.said.some((line) => /CRITICAL/.test(line)));
  assert.match(p.asked.at(-1), /yolo\)\? \[y\/N\]/);
});

test("interactive defaults follow current config values and offer the cheapest fast model", async () => {
  const doc = YAML.parseDocument("modelRoles:\n  default: alpha/big:medium\n  nemo-review: alpha/small:high\n");
  const d = computeDefaults(models, doc, null, {});
  assert.equal(d.impl, "alpha/big:medium");
  assert.equal(d.review, "alpha/small:high");
  const p = scripted(["", "", "", "y", "", "", "", "", "", "", "", "", "", "", "", "", "", "y"]);
  const choices = await askChoices(p, models, d);
  assert.equal(p.remaining(), 0);
  assert.deepEqual(choices, {
    impl: "alpha/big:medium",
    fast: "alpha/small:low",
    advisor: "alpha/big:medium",
    advisorCritical: "alpha/big:high",
    review: "alpha/small:high",
    approval: "yolo",
  });
});

test("a model without thinking levels gets no suffix and no thinking question", async () => {
  const d = computeDefaults(models, YAML.parseDocument(""), null, { impl: "alpha/plain" });
  assert.equal(d.impl, "alpha/plain");
  const p = scripted(["", "", "n", "n", "", "", "", "n"]);
  const choices = await askChoices(p, models, d);
  assert.equal(p.remaining(), 0);
  assert.equal(choices.impl, "alpha/plain");
  assert.equal(p.said.filter((l) => /Implementation.*thinking/.test(l)).length, 0);
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
  const d = computeDefaults(loaded, YAML.parseDocument(""), null, {});
  assert.equal(d.fastSuggestion, "alpha/small:low");
});
