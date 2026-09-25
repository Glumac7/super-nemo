import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { REPO } from "./helpers.mjs";

test("every agent's autoloadSkills names a shipped skill", () => {
  const skills = new Set(fs.readdirSync(path.join(REPO, "skills")));
  for (const f of fs.readdirSync(path.join(REPO, "agents"))) {
    const text = fs.readFileSync(path.join(REPO, "agents", f), "utf8");
    const fm = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(text)[1]);
    for (const name of fm.autoloadSkills ?? []) assert.ok(skills.has(name), `${f}: ${name} is not in skills/`);
  }
});
