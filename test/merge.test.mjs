import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS_BODY, agentsBody, blockStartsWith, displayName, normalizeName, removeBlock, upsertBlock } from "../lib/merge.mjs";

test("marker block round-trips for every trailing-newline shape, even after edits above it", () => {
  for (const original of ["", "text", "text\n", "text\n\n", "a\r\nb\r\n"]) {
    const added = upsertBlock(original, "@~/x.md", "f");
    assert.match(added.text, /<!-- super-nemo:begin -->\n@~\/x\.md\n<!-- super-nemo:end -->\n$/);
    assert.equal(removeBlock(added.text, added, "f").text, original, JSON.stringify(original));
    const edited = `new first line\n${added.text}`;
    assert.equal(removeBlock(edited, added, "f").text, `new first line\n${original}`);
  }
});

test("text after the block is kept when the block is removed", () => {
  const added = upsertBlock("top\n", "@~/x.md", "f");
  const edited = `${added.text}user tail\n`;
  assert.equal(removeBlock(edited, added, "f").text, "top\nuser tail\n");
});

test("names normalize to a lowercase prefix word and reject anything that cannot follow super-", () => {
  for (const [raw, name] of [["jake", "jake"], [" Jake ", "jake"], ["super-jake", "jake"], ["SUPER-R2-D2", "r2-d2"], ["nemo", "nemo"]]) {
    assert.equal(normalizeName(raw), name, raw);
  }
  for (const raw of ["", "super-", "-jake", "jake doe", "jäke", "jake:", "a".repeat(31), undefined, null]) {
    assert.equal(normalizeName(raw), null, String(raw));
  }
  assert.equal(displayName("jake"), "SUPER-JAKE");
  assert.equal(displayName(undefined), "SUPER-NEMO");
});

test("the default name keeps the plain AGENTS.md import; another name adds its prefixes after it", () => {
  assert.equal(agentsBody(), AGENTS_BODY);
  assert.equal(agentsBody("nemo"), AGENTS_BODY);
  const body = agentsBody("jake");
  assert.ok(body.startsWith(`${AGENTS_BODY}\n\n`));
  assert.match(body, /called SUPER-JAKE/);
  for (const prefix of ["super-jake:", "super-jake light:", "super-jake normal:", "super-jake critical:"]) assert.ok(body.includes(`\`${prefix}\``), prefix);
  assert.match(body, /skill:\/\/super-nemo/);
});

test("a renamed block is still recognized as ours", () => {
  for (const name of ["nemo", "jake"]) {
    const { text } = upsertBlock("user text\n", agentsBody(name), "f");
    assert.ok(blockStartsWith(text, AGENTS_BODY), name);
  }
  assert.ok(!blockStartsWith(upsertBlock("", "@~/other.md", "f").text, AGENTS_BODY));
  assert.ok(!blockStartsWith(`<!-- super-nemo:begin -->\n${AGENTS_BODY}\n`, AGENTS_BODY));
});
