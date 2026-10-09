import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNoteMarkdown } from "./parseNoteMarkdown.js";

for (const ending of ["\r", "\r\n", "\n"]) {
  test(`line ending ${JSON.stringify(ending)} retains all paragraphs`, () => {
    for (const input of ["Alpha\n\nBeta\nGamma", "Title\n\nPara one\n\nAlpha\n\nBeta\n\nGamma"]) {
      const expected = parseNoteMarkdown(input);
      assert.deepEqual(parseNoteMarkdown(input.replaceAll("\n", ending)), expected);
    }
  });
  test(`line ending ${JSON.stringify(ending)} preserves Markdown styles and raw slices`, () => {
    const input = "## Heading\n\n> **Alpha**\n> Beta\n\n- [x] Task\n\n[link](https://example.com) and `literal`\n\n```\ncode one\ncode two\n```";
    assert.deepEqual(parseNoteMarkdown(input.replaceAll("\n", ending)), parseNoteMarkdown(input));
  });
}

test("mixed CR, CRLF and LF retain the trailing paragraph", () => {
  assert.deepEqual(parseNoteMarkdown("Title\n\nPara one\r\n\r\nAlpha\r\rBeta\n\nGamma"),
    parseNoteMarkdown("Title\n\nPara one\n\nAlpha\n\nBeta\n\nGamma"));
});
