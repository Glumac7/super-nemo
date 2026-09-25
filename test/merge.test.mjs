import assert from "node:assert/strict";
import { test } from "node:test";
import { removeBlock, upsertBlock } from "../lib/merge.mjs";

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
