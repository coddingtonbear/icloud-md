import { test } from "node:test";
import assert from "node:assert/strict";
import { formatsRoundTripEqual, PLAIN_STYLE, type FormatParagraph, type InlineSpan } from "./noteFormat.js";
import { parseNoteMarkdown } from "./parseNoteMarkdown.js";
import { renderNoteMarkdown } from "./renderNoteMarkdown.js";

function p(kind: FormatParagraph["kind"], text: string, extra: Partial<FormatParagraph> = {}): FormatParagraph {
  const spans: InlineSpan[] = text.length ? [{ ...PLAIN_STYLE, length: text.length }] : [];
  return { kind, indent: 0, blockQuoteLevel: 0, startNumber: 0, text, spans, start: 0, ...extra };
}

/** Step 2's core invariant, checked per case: `parse(render(model))` must
 * reproduce the exact plain text and the rendered-formatting projection. */
function assertRoundTrips(paragraphs: FormatParagraph[]): string {
  const rendered = renderNoteMarkdown(paragraphs);
  const back = parseNoteMarkdown(rendered);
  assert.equal(back.status, "ok", back.status === "ok" ? undefined : `parse failed: ${back.reason}\nrendered: ${JSON.stringify(rendered)}`);
  if (back.status !== "ok") throw new Error("unreachable");
  assert.equal(back.text, paragraphs.map((x) => x.text).join("\n"), `text drifted through ${JSON.stringify(rendered)}`);
  assert.equal(formatsRoundTripEqual(paragraphs, back.paragraphs), true, `formatting drifted through ${JSON.stringify(rendered)}`);
  return rendered;
}

test("title/heading/subheading render as #/##/### and round-trip", () => {
  const rendered = assertRoundTrips([p("title", "My Note"), p("heading", "H"), p("subheading", "S"), p("body", "text")]);
  assert.equal(rendered, "# My Note\n## H\n### S\ntext");
});

test("checklists render as GFM task items, including empty ones", () => {
  const rendered = assertRoundTrips([
    p("todoList", "one", { done: false }),
    p("todoList", "two", { done: true }),
    p("todoList", "", { done: false }),
    p("todoList", "", { done: true }),
  ]);
  assert.equal(rendered, "- [ ] one\n- [x] two\n- [ ]\n- [x]");
});

test("a bullet item whose literal text is [ ] renders escaped and stays a bullet", () => {
  const rendered = assertRoundTrips([p("bulletList", "[ ]")]);
  assert.notEqual(rendered, "- [ ]");
});

test("blank lines are real empty paragraphs everywhere - between blocks, between lists, in quotes", () => {
  assertRoundTrips([p("body", "a"), p("body", ""), p("body", ""), p("body", "b")]);
  assertRoundTrips([p("bulletList", "a"), p("body", ""), p("bulletList", "b")]);
  assertRoundTrips([p("body", "q1", { blockQuoteLevel: 1 }), p("body", "", { blockQuoteLevel: 1 }), p("body", "q2", { blockQuoteLevel: 1 })]);
  assertRoundTrips([p("body", "a"), p("body", "")]); // trailing newline
});

test("list nesting, type switches, and numbered starts round-trip", () => {
  assertRoundTrips([
    p("bulletList", "top"),
    p("bulletList", "deep", { indent: 1 }),
    p("numberedList", "num", { indent: 1 }),
    p("bulletList", "back"),
  ]);
  const rendered = assertRoundTrips([p("numberedList", "five", { startNumber: 5 }), p("numberedList", "six")]);
  assert.equal(rendered, "5. five\n6. six");
});

test("dash lists render as - items (projection collapses them into bullets)", () => {
  const rendered = renderNoteMarkdown([p("dashList", "item")]);
  assert.equal(rendered, "- item");
});

test("a body line directly after a list or quote is not lazily absorbed", () => {
  const list = assertRoundTrips([p("bulletList", "item"), p("body", "directly after")]);
  assert.equal(list, "- item\ndirectly after");
  const quote = assertRoundTrips([p("body", "quoted", { blockQuoteLevel: 1 }), p("body", "outside")]);
  assert.equal(quote, "> quoted\noutside");
});

test("monospaced paragraphs group into a fenced block, preserving interior blanks and escalating fences", () => {
  const rendered = assertRoundTrips([
    p("body", "before"),
    p("monospaced", "code line"),
    p("monospaced", ""),
    p("monospaced", "more"),
    p("body", "after"),
  ]);
  assert.equal(rendered, "before\n```\ncode line\n\nmore\n```\nafter");
  // A mono line that is itself ``` needs a longer fence.
  assertRoundTrips([p("monospaced", "```"), p("monospaced", "inner")]);
});

test("markdown-significant plain text renders escaped", () => {
  assertRoundTrips([
    p("body", "- [ ] not a todo"),
    p("body", "# not a heading"),
    p("body", "1. not a list"),
    p("body", "> not a quote"),
    p("body", "a <u>literal</u> b"),
    p("body", "*stars* and _underscores_"),
  ]);
});

test("inline styles nest and round-trip; whole-range styles wrap outermost", () => {
  assertRoundTrips([
    {
      ...p("body", "bold italic struck under"),
      spans: [
        { ...PLAIN_STYLE, bold: true, length: 4 },
        { ...PLAIN_STYLE, length: 1 },
        { ...PLAIN_STYLE, italic: true, length: 6 },
        { ...PLAIN_STYLE, length: 1 },
        { ...PLAIN_STYLE, strikethrough: true, length: 6 },
        { ...PLAIN_STYLE, length: 1 },
        { ...PLAIN_STYLE, underline: true, length: 5 },
      ],
    },
  ]);
  // A whole-line italic containing a bold word must not produce ambiguous
  // adjacent delimiter runs (the s15 regression from the live probe note).
  const rendered = assertRoundTrips([
    {
      ...p("body", "s15 rest of line"),
      spans: [
        { ...PLAIN_STYLE, bold: true, italic: true, length: 3 },
        { ...PLAIN_STYLE, italic: true, length: 13 },
      ],
    },
  ]);
  assert.equal(rendered, "***s15** rest of line*");
});

test("explicit links round-trip; bare URLs stay plain text in both directions", () => {
  const linked = assertRoundTrips([
    {
      ...p("body", "see docs here"),
      spans: [
        { ...PLAIN_STYLE, length: 4 },
        { ...PLAIN_STYLE, link: "https://example.com/", length: 9 },
      ],
    },
  ]);
  assert.equal(linked, "see [docs here](https://example.com/)");
  // A bare-URL link span normalizes away; the rendered text suppresses the
  // GFM autolink with an escape, and parsing ignores autolink literals.
  assertRoundTrips([
    { ...p("body", "https://example.com/x"), spans: [{ ...PLAIN_STYLE, link: "https://example.com/x", length: 21 }] },
  ]);
});

test("checklists inside blockquotes round-trip", () => {
  const rendered = assertRoundTrips([p("todoList", "quoted todo", { done: false, blockQuoteLevel: 1 })]);
  assert.equal(rendered, "> - [ ] quoted todo");
});

test("U+FFFC placeholders pass through rendering and parsing untouched", () => {
  assertRoundTrips([p("body", "￼"), p("body", "text ￼ inline")]);
});

test("parser refuses constructs Apple Notes can't express, with precise reasons", () => {
  const deep = parseNoteMarkdown("#### too deep");
  assert.equal(deep.status, "unsupported");
  if (deep.status === "unsupported") assert.match(deep.reason, /depth-4 heading/);

  const rule = parseNoteMarkdown("a\n\n---\n\nb");
  assert.equal(rule.status, "unsupported");
  if (rule.status === "unsupported") assert.match(rule.reason, /thematic break/);

  const html = parseNoteMarkdown("<div>\nblock\n</div>");
  assert.equal(html.status, "unsupported");
  if (html.status === "unsupported") assert.match(html.reason, /HTML block/);
});

test("parser degrades unsupported inline constructs to their literal source text", () => {
  const result = parseNoteMarkdown("some `inline code` here");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.text, "some `inline code` here");
});

test("parser splits lazy continuations out of lists and quotes as Body paragraphs", () => {
  const result = parseNoteMarkdown("> quoted\nlazy line");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(
    result.paragraphs.map((q) => [q.kind, q.blockQuoteLevel, q.text]),
    [
      ["body", 1, "quoted"],
      ["body", 0, "lazy line"],
    ],
  );
});

test("parser accepts common hand-written variants the renderer never emits", () => {
  // Asterisk bullets, ordered lists renumbered oddly, setext headings.
  const bullets = parseNoteMarkdown("* item");
  assert.equal(bullets.status, "ok");
  if (bullets.status === "ok") assert.equal(bullets.paragraphs[0]?.kind, "bulletList");

  const setext = parseNoteMarkdown("Title\n=====");
  assert.equal(setext.status, "ok");
  if (setext.status === "ok") {
    assert.deepEqual(
      setext.paragraphs.map((q) => [q.kind, q.text]),
      [["title", "Title"]],
    );
  }
});
