import { test } from "node:test";
import assert from "node:assert/strict";
import { findMarkdownTableBlocks, parseMarkdownTable, renderMarkdownTable } from "./markdownTable.js";

// --- renderMarkdownTable ----------------------------------------------------

test("renderMarkdownTable pins the exact remark output format", () => {
  // The renderer's byte output feeds cloned files and version-history diffs -
  // if this test breaks, on-disk tables written after the change will differ
  // from ones written before it (see the module header and the dev log).
  assert.equal(
    renderMarkdownTable([
      ["A0", "B0"],
      ["A1", ""],
    ]),
    ["| A0 | B0 |", "| - | - |", "| A1 | |"].join("\n"),
  );
});

test("renderMarkdownTable escapes markdown punctuation in cell text so it round-trips literally", () => {
  const rendered = renderMarkdownTable([["*bold*", "plain"]]);
  assert.deepEqual(parseMarkdownTable(rendered), [["*bold*", "plain"]]);
});

test("renderMarkdownTable throws on an empty grid", () => {
  assert.throws(() => renderMarkdownTable([]), /no rows/);
});

// --- parseMarkdownTable -------------------------------------------------------

test("parseMarkdownTable is the exact inverse of renderMarkdownTable for a real decoded grid", () => {
  const grid = [
    ["A0", "B0"],
    ["A1", "B1"],
  ];
  assert.deepEqual(parseMarkdownTable(renderMarkdownTable(grid)), grid);
});

test("parseMarkdownTable round-trips pipes, backslashes, and embedded newlines", () => {
  const grid = [
    ["a|b", "line1\nline2"],
    ["back\\slash", "plain"],
  ];
  assert.deepEqual(parseMarkdownTable(renderMarkdownTable(grid)), grid);
});

test("parseMarkdownTable round-trips cell text full of markdown syntax", () => {
  const grid = [
    ["*emphasis*", "`code`", "[link](https://example.com)"],
    ["_under_", "~~strike~~", "www.example.com"],
  ];
  assert.deepEqual(parseMarkdownTable(renderMarkdownTable(grid)), grid);
});

test("parseMarkdownTable round-trips empty cells and empty rows", () => {
  const grid = [
    ["a", "b", "c"],
    ["", "", ""],
  ];
  assert.deepEqual(parseMarkdownTable(renderMarkdownTable(grid)), grid);
});

test("parseMarkdownTable accepts a header-and-separator-only table", () => {
  assert.deepEqual(parseMarkdownTable(renderMarkdownTable([["Only", "Header"]])), [["Only", "Header"]]);
});

test("parseMarkdownTable throws on a row with the wrong column count", () => {
  const markdown = ["| A | B |", "| --- | --- |", "| only-one |"].join("\n");
  assert.throws(() => parseMarkdownTable(markdown), /column count/);
});

test("parseMarkdownTable throws when the separator row isn't a GFM separator", () => {
  const markdown = ["| A | B |", "| not a separator |"].join("\n");
  assert.throws(() => parseMarkdownTable(markdown));
});

test("parseMarkdownTable throws on prose around the table", () => {
  const markdown = ["prose first", "| A |", "| --- |"].join("\n");
  assert.throws(() => parseMarkdownTable(markdown));
});

// --- compatibility with the previous hand-rolled renderer's on-disk format ---

test("parseMarkdownTable reads the previous renderer's exact output format", () => {
  // Literal old-format bytes (as `renderMarkdownTable` produced them before
  // the remark migration): `---` separators, two-space empty cells, `\\` and
  // `\|` escapes, `<br>` newlines. Files cloned before the migration keep
  // this shape on disk until a remote change rewrites them, and must keep
  // parsing to the identical grid or push would see phantom table edits.
  const oldFormat = ["| A0 | pipe\\|cell |", "| --- | --- |", "| back\\\\slash | multi<br>line |", "|  |  |"].join("\n");
  assert.deepEqual(parseMarkdownTable(oldFormat), [
    ["A0", "pipe|cell"],
    ["back\\slash", "multi\nline"],
    ["", ""],
  ]);
});

test("parseMarkdownTable keeps unescaped markdown syntax in old-format cells as literal text", () => {
  // The previous renderer never escaped markdown punctuation, so a stored
  // cell text of literally `*bold*` sits unescaped in pre-migration files -
  // it must parse back as `*bold*` (matching the CRDT's stored cell text),
  // not collapse to `bold`.
  const oldFormat = ["| *bold* | `code` |", "| --- | --- |", "| [link](x) | plain |"].join("\n");
  assert.deepEqual(parseMarkdownTable(oldFormat), [
    ["*bold*", "`code`"],
    ["[link](x)", "plain"],
  ]);
});

// --- findMarkdownTableBlocks ---------------------------------------------------

test("findMarkdownTableBlocks finds a single table surrounded by prose", () => {
  const text = ["Some intro text.", "", renderMarkdownTable([["A", "B"]]), "", "Some trailing text."].join("\n");
  const blocks = findMarkdownTableBlocks(text);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0]?.grid, [["A", "B"]]);
});

test("findMarkdownTableBlocks finds multiple tables in document order", () => {
  const text = [
    "Intro",
    renderMarkdownTable([["First"]]),
    "Middle text",
    renderMarkdownTable([["Second", "Table"]]),
    "Outro",
  ].join("\n");
  const blocks = findMarkdownTableBlocks(text);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0]?.grid, [["First"]]);
  assert.deepEqual(blocks[1]?.grid, [["Second", "Table"]]);
});

test("findMarkdownTableBlocks finds nothing in plain prose with no tables", () => {
  assert.deepEqual(findMarkdownTableBlocks("Just a normal note.\nWith a few lines.\nNo tables here."), []);
});

test("findMarkdownTableBlocks reports correct line ranges for splicing back out", () => {
  const text = ["line0", "| A |", "| --- |", "| B |", "line4"].join("\n");
  const blocks = findMarkdownTableBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.startLine, 1);
  assert.equal(blocks[0]?.endLine, 4);
});

test("findMarkdownTableBlocks does not absorb prose directly below a table (GFM lazy continuation)", () => {
  // The normal spliced-note shape: body text continues on the very next
  // line after a table, no blank line between. GFM's parser lazily absorbs
  // that prose line into the table as a one-cell row; the block must end at
  // the last strict pipe row instead.
  const text = ["| A | B |", "| - | - |", "| 1 | 2 |", "prose continues here"].join("\n");
  const blocks = findMarkdownTableBlocks(text);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0]?.grid, [
    ["A", "B"],
    ["1", "2"],
  ]);
  assert.equal(blocks[0]?.endLine, 3);
});

test("findMarkdownTableBlocks ends a block at a row with the wrong column count", () => {
  const text = ["| A | B |", "| - | - |", "| 1 | 2 |", "| widowed |"].join("\n");
  const blocks = findMarkdownTableBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.endLine, 3);
  assert.deepEqual(blocks[0]?.grid, [
    ["A", "B"],
    ["1", "2"],
  ]);
});

test("findMarkdownTableBlocks ignores tables inside fenced code blocks", () => {
  // The previous line scanner false-positived on these.
  const text = ["```", "| X |", "| --- |", "| fenced |", "```", "", renderMarkdownTable([["Real", "Table"]])].join("\n");
  const blocks = findMarkdownTableBlocks(text);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0]?.grid, [["Real", "Table"]]);
});

test("findMarkdownTableBlocks ignores tables nested inside blockquotes", () => {
  // A nested table can't be one this project spliced in, and replacing its
  // whole lines would corrupt the container's `>` markers.
  const text = ["> | q | r |", "> | --- | --- |", "> | 1 | 2 |"].join("\n");
  assert.deepEqual(findMarkdownTableBlocks(text), []);
});

test("findMarkdownTableBlocks reads old-format tables (--- separators) identically", () => {
  const text = ["Intro prose.", "", "| A0 | B0 |", "| --- | --- |", "|  |  |", "", "Outro."].join("\n");
  const blocks = findMarkdownTableBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.startLine, 2);
  assert.equal(blocks[0]?.endLine, 5);
  assert.deepEqual(blocks[0]?.grid, [
    ["A0", "B0"],
    ["", ""],
  ]);
});
