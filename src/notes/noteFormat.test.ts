import { test } from "node:test";
import assert from "node:assert/strict";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AttributeRunSchema } from "./gen/topotext_pb.js";
import {
  decodeNoteFormat,
  formatsRoundTripEqual,
  normalizeSpans,
  PLAIN_STYLE,
  type FormatParagraph,
  type InlineSpan,
} from "./noteFormat.js";

function runs(...inits: MessageInitShape<typeof AttributeRunSchema>[]) {
  return inits.map((init) => create(AttributeRunSchema, init));
}

function paragraph(text: string, overrides: Partial<FormatParagraph> = {}): FormatParagraph {
  const spans: InlineSpan[] = text.length === 0 ? [] : [{ ...PLAIN_STYLE, length: text.length }];
  return { kind: "body", indent: 0, blockQuoteLevel: 0, startNumber: 0, text, spans, start: 0, ...overrides };
}

test("decode maps every wire style value to its paragraph kind", () => {
  const text = "t\nh\ns\nb\nm\nu\nd\nn\nc";
  const result = decodeNoteFormat(
    text,
    runs(
      { length: 2, paragraphStyle: { style: 0 } },
      { length: 2, paragraphStyle: { style: 1 } },
      { length: 2, paragraphStyle: { style: 2 } },
      { length: 2, paragraphStyle: { style: 3 } },
      { length: 2, paragraphStyle: { style: 4 } },
      { length: 2, paragraphStyle: { style: 100 } },
      { length: 2, paragraphStyle: { style: 101 } },
      { length: 2, paragraphStyle: { style: 102 } },
      { length: 1, paragraphStyle: { style: 103, todo: { todoUUID: new Uint8Array(16), done: 1 } } },
    ),
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(
    result.paragraphs.map((p) => p.kind),
    ["title", "heading", "subheading", "body", "monospaced", "bulletList", "dashList", "numberedList", "todoList"],
  );
  assert.equal(result.paragraphs[8]?.done, true);
});

test("decode treats absent paragraphStyle and explicit style 3 identically as Body", () => {
  // Style 3 = Body written explicitly; a paragraphStyle carrying only an
  // indent (no style field) is Body too - dev log 2026-07-17T10:16. Note
  // style 0 means Title, so field *presence* has to be inspected.
  const a = decodeNoteFormat("x", runs({ length: 1, paragraphStyle: { style: 3 } }));
  const b = decodeNoteFormat("x", runs({ length: 1 }));
  const c = decodeNoteFormat("x", runs({ length: 1, paragraphStyle: { indent: 2 } }));
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
  assert.equal(c.status, "ok");
  if (a.status !== "ok" || b.status !== "ok" || c.status !== "ok") return;
  assert.equal(a.paragraphs[0]?.kind, "body");
  assert.equal(b.paragraphs[0]?.kind, "body");
  assert.equal(c.paragraphs[0]?.kind, "body");
  assert.equal(c.paragraphs[0]?.indent, 2);
  assert.equal(formatsRoundTripEqual(a.paragraphs, b.paragraphs), true);
  // Non-list indent isn't rendered, so it doesn't participate in equality.
  assert.equal(formatsRoundTripEqual(a.paragraphs, c.paragraphs), true);
});

test("decode refuses an unknown paragraph style value", () => {
  const result = decodeNoteFormat("x", runs({ length: 1, paragraphStyle: { style: 7 } }));
  assert.equal(result.status, "unsupported");
  if (result.status !== "unsupported") return;
  assert.match(result.reason, /paragraph style \(7\)/);
});

test("decode tolerates under-covering runs (uncovered tail is plain Body) but refuses overshoot", () => {
  const under = decodeNoteFormat("covered and not", runs({ length: 7, fontHints: 1 }));
  assert.equal(under.status, "ok");
  if (under.status !== "ok") return;
  assert.deepEqual(under.paragraphs[0]?.spans, [
    { ...PLAIN_STYLE, bold: true, length: 7 },
    { ...PLAIN_STYLE, length: 8 },
  ]);

  const over = decodeNoteFormat("ab", runs({ length: 5 }));
  assert.equal(over.status, "unsupported");
});

test("a paragraph's attributes come from the run covering its newline; a run may span lines", () => {
  // One run covers "one\ntwo\n" (both lines heading), a second covers the
  // last line without a newline (subheading via last character).
  const result = decodeNoteFormat(
    "one\ntwo\nthree",
    runs({ length: 8, paragraphStyle: { style: 1 } }, { length: 5, paragraphStyle: { style: 2 } }),
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(
    result.paragraphs.map((p) => p.kind),
    ["heading", "heading", "subheading"],
  );
});

test("adjacent equal inline runs merge into one span; fontHints bits map to bold/italic", () => {
  const result = decodeNoteFormat(
    "abcdef",
    runs({ length: 2, fontHints: 3 }, { length: 2, fontHints: 3, timestamp: 9n }, { length: 2, underline: 1 }),
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  // The timestamp field is opaque; the two fontHints=3 runs have equal
  // *rendered* styling and merge into one span.
  assert.deepEqual(result.paragraphs[0]?.spans, [
    { ...PLAIN_STYLE, bold: true, italic: true, length: 4 },
    { ...PLAIN_STYLE, underline: true, length: 2 },
  ]);
});

test("normalizeSpans collapses a bare-URL link (link == covered text) to plain text", () => {
  const url = "https://example.com/x";
  const p = paragraph(url, { spans: [{ ...PLAIN_STYLE, link: url, length: url.length }] });
  assert.deepEqual(normalizeSpans(p), [{ ...PLAIN_STYLE, length: url.length }]);
  // ...even when the URL was split across runs that only merge during
  // normalization.
  const split = paragraph(url, {
    spans: [
      { ...PLAIN_STYLE, link: url, length: 10 },
      { ...PLAIN_STYLE, link: url, length: url.length - 10 },
    ],
  });
  assert.deepEqual(normalizeSpans(split), [{ ...PLAIN_STYLE, length: url.length }]);
});

test("normalizeSpans keeps an explicit link whose text differs from its target", () => {
  const p = paragraph("docs", { spans: [{ ...PLAIN_STYLE, link: "https://example.com/", length: 4 }] });
  assert.deepEqual(normalizeSpans(p), [{ ...PLAIN_STYLE, link: "https://example.com/", length: 4 }]);
});

test("normalizeSpans drops inline styling inside monospaced paragraphs", () => {
  const p = paragraph("code", { kind: "monospaced", spans: [{ ...PLAIN_STYLE, bold: true, length: 4 }] });
  assert.deepEqual(normalizeSpans(p), [{ ...PLAIN_STYLE, length: 4 }]);
});

test("normalizeSpans retreats bold/italic/strikethrough off whitespace at span edges, keeping underline", () => {
  // "ab cd": italic covers " cd" (leading space) - CommonMark can't express
  // `* cd*`, so the space sheds the italic; underline keeps its exact extent.
  const p = paragraph("ab cd", {
    spans: [
      { ...PLAIN_STYLE, length: 2 },
      { ...PLAIN_STYLE, italic: true, underline: true, length: 3 },
    ],
  });
  assert.deepEqual(normalizeSpans(p), [
    { ...PLAIN_STYLE, length: 2 },
    { ...PLAIN_STYLE, underline: true, length: 1 },
    { ...PLAIN_STYLE, italic: true, underline: true, length: 2 },
  ]);
});

test("projection equality: dash and bullet lists are interchangeable, checklist done state is not", () => {
  const dash = [paragraph("item", { kind: "dashList" })];
  const bullet = [paragraph("item", { kind: "bulletList" })];
  assert.equal(formatsRoundTripEqual(dash, bullet), true);

  const unchecked = [paragraph("todo", { kind: "todoList", done: false })];
  const checked = [paragraph("todo", { kind: "todoList", done: true })];
  assert.equal(formatsRoundTripEqual(unchecked, checked), false);
});

test("projection equality: numbered start matters only at a group's first item", () => {
  const a = [paragraph("one", { kind: "numberedList", startNumber: 5 }), paragraph("two", { kind: "numberedList", startNumber: 0 })];
  const b = [paragraph("one", { kind: "numberedList", startNumber: 5 }), paragraph("two", { kind: "numberedList", startNumber: 9 })];
  assert.equal(formatsRoundTripEqual(a, b), true);

  const c = [paragraph("one", { kind: "numberedList", startNumber: 4 }), paragraph("two", { kind: "numberedList", startNumber: 0 })];
  assert.equal(formatsRoundTripEqual(a, c), false);
});
