import { test } from "node:test";
import assert from "node:assert/strict";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.js";

/** The core invariant: split is lossless - frontmatter + body === input. */
function assertLossless(text: string): ReturnType<typeof splitFrontmatter> {
  const split = splitFrontmatter(text);
  assert.equal(joinFrontmatter(split.frontmatter, split.body), text, `not lossless for ${JSON.stringify(text)}`);
  return split;
}

test("a file with no frontmatter is all body", () => {
  const split = assertLossless("# Title\nbody line");
  assert.equal(split.frontmatter, "");
  assert.equal(split.body, "# Title\nbody line");
});

test("frontmatter directly above the title splits off with the body byte-identical to render output", () => {
  const split = assertLossless("---\ntags: [a, b]\n---\n# Title\nbody");
  assert.equal(split.frontmatter, "---\ntags: [a, b]\n---\n");
  assert.equal(split.body, "# Title\nbody");
});

test("a blank line between the closing fence and the title is folded into the envelope", () => {
  const split = assertLossless("---\ntags: [a]\n---\n\n# Title\nbody");
  assert.equal(split.frontmatter, "---\ntags: [a]\n---\n\n");
  assert.equal(split.body, "# Title\nbody");
});

test("multiple blank lines after the fence all belong to the envelope", () => {
  const split = assertLossless("---\nx: 1\n---\n\n\n# Title");
  assert.equal(split.frontmatter, "---\nx: 1\n---\n\n\n");
  assert.equal(split.body, "# Title");
});

test("a file that is only frontmatter has an empty body", () => {
  const split = assertLossless("---\nx: 1\n---");
  assert.equal(split.frontmatter, "---\nx: 1\n---");
  assert.equal(split.body, "");
});

test("a file that is only frontmatter with a trailing newline still has an empty body", () => {
  const split = assertLossless("---\nx: 1\n---\n");
  assert.equal(split.frontmatter, "---\nx: 1\n---\n");
  assert.equal(split.body, "");
});

test("a note body that merely contains --- later is not frontmatter", () => {
  // A `---` that isn't the first line can't open frontmatter (the tool can't
  // produce a note body starting with a thematic break anyway).
  const split = assertLossless("# Title\n---\nmore");
  assert.equal(split.frontmatter, "");
  assert.equal(split.body, "# Title\n---\nmore");
});

test("an unterminated leading fence is treated as body, not frontmatter", () => {
  const split = assertLossless("---\nlooks like yaml\nbut never closes");
  assert.equal(split.frontmatter, "");
  assert.equal(split.body, "---\nlooks like yaml\nbut never closes");
});

test("empty input is empty body", () => {
  const split = assertLossless("");
  assert.equal(split.frontmatter, "");
  assert.equal(split.body, "");
});

test("empty frontmatter block (no keys) still splits", () => {
  const split = assertLossless("---\n---\n# Title");
  assert.equal(split.frontmatter, "---\n---\n");
  assert.equal(split.body, "# Title");
});

test("join re-attaches a preserved envelope above a freshly rendered body", () => {
  // Simulates the pull path: envelope captured from the old file, new body
  // from the renderer.
  const { frontmatter } = splitFrontmatter("---\ntags: [keep]\n---\n\n# Old Title\nold");
  assert.equal(joinFrontmatter(frontmatter, "# New Title\nnew body"), "---\ntags: [keep]\n---\n\n# New Title\nnew body");
});

test("join with no frontmatter is just the body", () => {
  assert.equal(joinFrontmatter("", "# Title"), "# Title");
});
