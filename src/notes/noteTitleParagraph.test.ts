import { test } from "node:test";
import assert from "node:assert/strict";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AttributeRunSchema } from "./gen/topotext_pb.js";
import { decodeNoteFormat, PLAIN_STYLE, type FormatParagraph, type ParagraphKind } from "./noteFormat.js";
import { renderNoteMarkdown } from "./renderNoteMarkdown.js";
import { parseNoteMarkdown } from "./parseNoteMarkdown.js";
import { restoreTitleParagraph, splitTitleParagraph, titleParagraphFromFilename } from "./noteTitleParagraph.js";

function runs(...inits: MessageInitShape<typeof AttributeRunSchema>[]) {
  return inits.map((init) => create(AttributeRunSchema, init));
}

function paragraph(kind: ParagraphKind, text: string, start = 0): FormatParagraph {
  return {
    kind,
    indent: 0,
    blockQuoteLevel: 0,
    startNumber: 0,
    text,
    spans: text.length > 0 ? [{ length: text.length, ...PLAIN_STYLE }] : [],
    start,
  };
}

test("splitting takes the first paragraph off and keeps the rest", () => {
  const model = [paragraph("title", "My Note"), paragraph("body", "", 8), paragraph("body", "Body text", 9)];

  const { title, body } = splitTitleParagraph(model);

  assert.equal(title?.text, "My Note");
  assert.equal(body.length, 2);
  assert.equal(body[0]?.text, "", "the blank paragraph below a title is real content and must survive");
});

test("splitting an empty model yields no title and no body", () => {
  const { title, body } = splitTitleParagraph([]);

  assert.equal(title, undefined);
  assert.deepEqual(body, []);
});

// The trap this module exists for: a note whose first paragraph is
// monospaced renders its first *line* as a ``` fence, so dropping the line
// would leave an unbalanced code block. Splitting the model can't.
test("a monospaced first paragraph splits without leaving an unbalanced fence", () => {
  const model = [paragraph("monospaced", "code line one"), paragraph("monospaced", "code line two", 14)];

  const { body } = splitTitleParagraph(model);
  const rendered = renderNoteMarkdown(body);

  assert.equal((rendered.match(/```/g) ?? []).length % 2, 0, `unbalanced fences in ${JSON.stringify(rendered)}`);
  assert.equal(parseNoteMarkdown(rendered).status, "ok");
});

test("a list first paragraph splits cleanly too", () => {
  const model = [paragraph("bulletList", "first item"), paragraph("bulletList", "second item", 11)];

  const rendered = renderNoteMarkdown(splitTitleParagraph(model).body);

  assert.equal(rendered, "- second item");
});

test("restoring puts the original paragraph back, style and all", () => {
  const title: FormatParagraph = {
    ...paragraph("heading", "Styled Title"),
    spans: [{ length: 12, ...PLAIN_STYLE, bold: true }],
  };
  const body = [paragraph("body", "Body text")];

  const restored = restoreTitleParagraph(title, body);

  assert.equal(restored[0]?.kind, "heading", "the original paragraph style survives the round trip");
  assert.equal(restored[0]?.spans[0]?.bold, true, "inline formatting survives too");
});

test("restoring recomputes start offsets across the whole model", () => {
  // Stale offsets would make formatReconcile restyle the wrong characters.
  const title = paragraph("title", "My Note");
  const body = [paragraph("body", "", 999), paragraph("body", "Body text", 999)];

  const restored = restoreTitleParagraph(title, body);

  assert.deepEqual(
    restored.map((p) => p.start),
    [0, 8, 9],
  );
});

test("restoring leaves the input paragraphs untouched", () => {
  const body = [paragraph("body", "Body text", 0)];

  restoreTitleParagraph(paragraph("title", "My Note"), body);

  assert.equal(body[0]?.start, 0, "the caller's model must not be mutated");
});

test("a filename-derived title is plain text in Apple's title style", () => {
  const title = titleParagraphFromFilename("Renamed Note");

  assert.equal(title.kind, "title");
  assert.equal(title.text, "Renamed Note");
  assert.deepEqual(title.spans, [{ length: 12, ...PLAIN_STYLE }]);
});

test("a filename-derived title with no text carries no spans", () => {
  assert.deepEqual(titleParagraphFromFilename("").spans, []);
});

test("split then restore reproduces the original model exactly", () => {
  const model = [
    paragraph("title", "My Note"),
    paragraph("body", "", 8),
    paragraph("bulletList", "one", 9),
    paragraph("bulletList", "two", 13),
  ];

  const { title, body } = splitTitleParagraph(model);
  assert.ok(title);
  const restored = restoreTitleParagraph(title, body);

  assert.deepEqual(restored, model);
});

test("the stripped body survives the render/parse round trip on its own", () => {
  // The round-trip gate has to hold for the *projection* that reaches the
  // file, not just for the whole note.
  const model = [
    paragraph("title", "My Note"),
    paragraph("body", "", 8),
    paragraph("heading", "A section", 9),
    paragraph("body", "Some prose.", 19),
  ];

  const rendered = renderNoteMarkdown(splitTitleParagraph(model).body);
  const reparsed = parseNoteMarkdown(rendered);

  assert.equal(reparsed.status, "ok");
  assert.equal(reparsed.status === "ok" ? reparsed.text : "", "\nA section\nSome prose.");
});

test("decoded real formatting splits and restores without loss", () => {
  // Exercises the module against decodeNoteFormat's own output rather than
  // hand-built paragraphs: a title-styled first line, a blank, then body.
  const decoded = decodeNoteFormat(
    "My Note\n\nBody text",
    runs(
      { length: 8, paragraphStyle: { style: 0 } },
      { length: 1, paragraphStyle: { style: 3 } },
      { length: 9, paragraphStyle: { style: 3 } },
    ),
  );
  assert.equal(decoded.status, "ok");
  if (decoded.status !== "ok") {
    return;
  }

  const { title, body } = splitTitleParagraph(decoded.paragraphs);
  assert.ok(title);
  assert.equal(title.kind, "title");
  assert.deepEqual(restoreTitleParagraph(title, body), decoded.paragraphs);
});
