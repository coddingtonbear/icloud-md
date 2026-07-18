import { test } from "node:test";
import assert from "node:assert/strict";
import { create, isFieldSet, type MessageInitShape } from "@bufbuild/protobuf";
import { AttributeRunSchema, ColorSchema, ParagraphStyleSchema, TodoSchema } from "./gen/topotext_pb.js";
import { reconcileNoteFormat } from "./formatReconcile.js";
import { decodeNoteFormat } from "./noteFormat.js";
import { parseNoteMarkdown } from "./parseNoteMarkdown.js";
import { applyTextEdit, buildInitialNoteDocument, type NoteDocument, type TextRun } from "./noteDocument.js";

const REPLICA_A = new Uint8Array(16).fill(0xaa);
const REPLICA_B = new Uint8Array(16).fill(0xbb);
const TODO_UUID = new Uint8Array(16).fill(0x77);

/** A consistent one-replica document (same skeleton as the captured saves)
 * whose attribute runs are supplied by the test. */
function docWith(text: string, attributeRuns: MessageInitShape<typeof AttributeRunSchema>[]): NoteDocument {
  const contentRun: TextRun = {
    coord: { replica: 1, clock: 0 },
    length: text.length,
    anchor: { replica: 1, clock: 0 },
    tombstone: false,
    sequence: [2],
  };
  return {
    rootSerializationVersion: 0,
    versionSerializationVersion: 0,
    minimumSupportedVersion: 0,
    text,
    runs: [
      { coord: { replica: 0, clock: 0 }, length: 0, anchor: { replica: 0, clock: 0 }, tombstone: false, sequence: [1] },
      contentRun,
      { coord: { replica: 0, clock: 0xffffffff }, length: 0, anchor: { replica: 0, clock: 0xffffffff }, tombstone: false, sequence: [] },
    ],
    replicas: [{ id: REPLICA_A, counters: [text.length, 3] }],
    attributeRuns: attributeRuns.map((init) => create(AttributeRunSchema, init)),
  };
}

function desired(markdown: string) {
  const parsed = parseNoteMarkdown(markdown);
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") throw new Error("unreachable");
  return parsed;
}

test("matching formatting is a no-op that leaves the document untouched", () => {
  const doc = docWith("plain line", [{ length: 10 }]);
  const runsBefore = doc.attributeRuns;
  const countersBefore = [...(doc.replicas[0]?.counters ?? [])];
  const result = reconcileNoteFormat(doc, desired("plain line").paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: false });
  assert.equal(doc.attributeRuns, runsBefore);
  assert.deepEqual(doc.replicas[0]?.counters, countersBefore);
});

test("a checklist done-toggle keeps the todo uuid and bumps only the op clock", () => {
  const doc = docWith("buy milk", [
    { length: 8, paragraphStyle: { style: 103, alignment: 4, todo: { todoUUID: TODO_UUID, done: 0 } } },
  ]);
  const result = reconcileNoteFormat(doc, desired("- [x] buy milk").paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });

  const run = doc.attributeRuns[0];
  assert.equal(doc.attributeRuns.length, 1);
  assert.equal(run?.paragraphStyle?.todo?.done, 1);
  // Identity preserved: a check-in-place is not a new checklist item.
  assert.deepEqual(run?.paragraphStyle?.todo?.todoUUID, TODO_UUID);
  // One formatting op consumed: op clock 3 was stamped, counter moved to 4.
  assert.deepEqual(doc.replicas[0]?.counters, [8, 4]);
  const contentRuns = doc.runs.filter((r) => r.length > 0);
  assert.deepEqual(contentRuns[0]?.anchor, { replica: 1, clock: 3 });
});

test("styling a paragraph clones the underlying run: opaque fields ride along", () => {
  const doc = docWith("make me a heading", [
    { length: 17, color: { red: 1, green: 0, blue: 0, alpha: 1 }, timestamp: 42n },
  ]);
  const result = reconcileNoteFormat(doc, desired("## make me a heading").paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });

  const run = doc.attributeRuns[0];
  assert.equal(doc.attributeRuns.length, 1);
  assert.equal(run?.paragraphStyle?.style, 1);
  assert.equal(run?.paragraphStyle?.alignment, 4);
  // The color and the opaque timestamp survived the paragraph-style rewrite.
  assert.deepEqual(run?.color, create(ColorSchema, { red: 1, green: 0, blue: 0, alpha: 1 }));
  assert.equal(run?.timestamp, 42n);
});

test("bolding a word splits runs, writes fontHints plus the web client's Font object, and restamps only that paragraph", () => {
  const doc = docWith("first line\nbold me here", [{ length: 23 }]);
  const result = reconcileNoteFormat(doc, desired("first line\n**bold** me here").paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });

  assert.deepEqual(
    doc.attributeRuns.map((run) => ({ length: run.length, fontHints: run.fontHints, font: run.font?.name })),
    [
      { length: 11, fontHints: 0, font: undefined },
      { length: 4, fontHints: 1, font: "SFUIText-Bold" },
      { length: 8, fontHints: 0, font: undefined },
    ],
  );
  // fontHints presence: the styled piece carries the explicit bit...
  assert.equal(isFieldSet(doc.attributeRuns[1]!, AttributeRunSchema.fields.find((f) => f.localName === "fontHints")!), true);
  // ...and only the changed paragraph's substrings were restamped.
  const contentRuns = doc.runs.filter((r) => r.length > 0 && !r.tombstone);
  assert.deepEqual(
    contentRuns.map((r) => ({ length: r.length, anchor: r.anchor })),
    [
      { length: 11, anchor: { replica: 1, clock: 0 } },
      { length: 12, anchor: { replica: 1, clock: 3 } },
    ],
  );
});

test("a dash-list paragraph edited only elsewhere keeps its 101 style verbatim", () => {
  const doc = docWith("dash item\nplain", [
    { length: 10, paragraphStyle: { style: 101, alignment: 4 } },
    { length: 5 },
  ]);
  // The file necessarily says "- dash item" (dash and bullet render alike);
  // making the *other* paragraph a heading must not rewrite the dash list.
  const result = reconcileNoteFormat(doc, desired("- dash item\n## plain").paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });
  assert.equal(doc.attributeRuns[0]?.paragraphStyle?.style, 101);
  assert.equal(doc.attributeRuns[1]?.paragraphStyle?.style, 1);
});

test("a new checklist paragraph gets a fresh web-client-shape style with a minted uuid", () => {
  const doc = docWith("todo item", [{ length: 9 }]);
  const result = reconcileNoteFormat(doc, desired("- [ ] todo item").paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });

  const ps = doc.attributeRuns[0]?.paragraphStyle;
  assert.equal(ps?.style, 103);
  assert.equal(ps?.alignment, 4);
  assert.equal(ps?.todo?.done, 0);
  assert.equal(ps?.todo?.todoUUID.length, 16);
  assert.equal(ps?.uuid.length, 0);
});

test("an attachmentInfo run keeps its attachment linkage through a paragraph-style change", () => {
  const doc = docWith("a\n￼", [
    { length: 2 },
    { length: 1, attachmentInfo: { attachmentIdentifier: "A-1", typeUTI: "public.jpeg" } },
  ]);
  const result = reconcileNoteFormat(doc, desired("> a\n> ￼").paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });

  const attachmentRun = doc.attributeRuns.find((run) => run.attachmentInfo !== undefined);
  assert.equal(attachmentRun?.length, 1);
  assert.equal(attachmentRun?.attachmentInfo?.attachmentIdentifier, "A-1");
  assert.equal(attachmentRun?.paragraphStyle?.blockQuoteLevel, 1);
});

test("a different replica reconciling joins the table at the observed clock maxima", () => {
  const doc = docWith("check me", [
    { length: 8, paragraphStyle: { style: 103, alignment: 4, todo: { todoUUID: TODO_UUID, done: 0 } } },
  ]);
  const result = reconcileNoteFormat(doc, desired("- [x] check me").paragraphs, REPLICA_B);
  assert.deepEqual(result, { ok: true, changed: true });
  // Replica B joined at [8, 3] (the maxima) and consumed op 3.
  assert.deepEqual(doc.replicas[1]?.counters, [8, 4]);
  const contentRuns = doc.runs.filter((r) => r.length > 0);
  assert.deepEqual(contentRuns[0]?.anchor, { replica: 2, clock: 3 });
});

test("create-path flow: text edit into an empty skeleton, then formatting reconcile", () => {
  const parsed = desired("# Title\n\n- [ ] first todo\n- [x] second");
  const doc = buildInitialNoteDocument(parsed.text, REPLICA_A);
  const result = reconcileNoteFormat(doc, parsed.paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });

  const decoded = decodeNoteFormat(doc.text, doc.attributeRuns);
  assert.equal(decoded.status, "ok");
  if (decoded.status !== "ok") return;
  assert.deepEqual(
    decoded.paragraphs.map((p) => [p.kind, p.done ?? null]),
    [
      ["title", null],
      ["body", null],
      ["todoList", false],
      ["todoList", true],
    ],
  );
});

test("formatting-only reconcile after a text edit composes with applyTextEdit", () => {
  const doc = docWith("old text", [{ length: 8 }]);
  const parsed = desired("## new heading");
  assert.equal(applyTextEdit(doc, parsed.text, { replicaId: REPLICA_A }), true);
  const result = reconcileNoteFormat(doc, parsed.paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });
  const decoded = decodeNoteFormat(doc.text, doc.attributeRuns);
  assert.equal(decoded.status, "ok");
  if (decoded.status !== "ok") return;
  assert.equal(decoded.paragraphs[0]?.kind, "heading");
});

test("two checklist items sharing an inherited todo uuid get the later one re-minted", () => {
  // The exact live-verification finding from 2026-07-18: an inserted line
  // inherits its neighbor's run wholesale, todo uuid included.
  const doc = docWith("todo two\nstep2 verify line", [
    { length: 9, paragraphStyle: { style: 103, alignment: 4, todo: { todoUUID: TODO_UUID, done: 0 } } },
    { length: 17, paragraphStyle: { style: 103, alignment: 4, todo: { todoUUID: TODO_UUID, done: 0 } } },
  ]);
  const result = reconcileNoteFormat(doc, desired("- [ ] todo two\n- [ ] step2 verify line").paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });

  const first = doc.attributeRuns[0]?.paragraphStyle?.todo;
  const second = doc.attributeRuns[doc.attributeRuns.length - 1]?.paragraphStyle?.todo;
  // The earlier item keeps its identity; the later duplicate re-minted.
  assert.deepEqual(first?.todoUUID, TODO_UUID);
  assert.equal(second?.todoUUID.length, 16);
  assert.notDeepEqual(second?.todoUUID, TODO_UUID);
});

test("numbered lists omit startingListItemNumber at the default start (explicit 0 renders from 0 in Notes)", () => {
  const startField = ParagraphStyleSchema.fields.find((f) => f.localName === "startingListItemNumber")!;
  const doc = docWith("num one\nnum two", [{ length: 15 }]);
  const result = reconcileNoteFormat(doc, desired("1. num one\n2. num two").paragraphs, REPLICA_A);
  assert.deepEqual(result, { ok: true, changed: true });
  for (const run of doc.attributeRuns) {
    assert.equal(run.paragraphStyle?.style, 102);
    assert.equal(isFieldSet(run.paragraphStyle!, startField), false);
  }

  // A genuine non-default start is written explicitly.
  const started = docWith("five", [{ length: 4 }]);
  assert.deepEqual(reconcileNoteFormat(started, desired("5. five").paragraphs, REPLICA_A), { ok: true, changed: true });
  assert.equal(started.attributeRuns[0]?.paragraphStyle?.startingListItemNumber, 5);
});

test("misaligned desired paragraphs refuse rather than guess", () => {
  const doc = docWith("one line", [{ length: 8 }]);
  const result = reconcileNoteFormat(doc, desired("different text").paragraphs, REPLICA_A);
  assert.equal(result.ok, false);
});
