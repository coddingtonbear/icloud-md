import { test } from "node:test";
import assert from "node:assert/strict";
import { planEmbedRepresentations } from "./embedPushEdit.js";
import { renderMarkdownTable } from "./markdownTable.js";
import { OBJECT_REPLACEMENT_CHARACTER, type EmbedSlot } from "./noteAttachments.js";
import { formatEmbedMarker } from "./unknownContent.js";

const NO_FILES = new Set<string>();

const GALLERY_SLOT: EmbedSlot = {
  kind: "attachment",
  ref: { attachmentIdentifier: "GALLERY-1", typeUti: "com.apple.notes.gallery" },
};
const GALLERY_MARKER = formatEmbedMarker({ attachmentIdentifier: "GALLERY-1", typeUti: "com.apple.notes.gallery" });
const UNKNOWN_SLOT: EmbedSlot = { kind: "unknown", typeUti: undefined };
const UNKNOWN_MARKER = formatEmbedMarker({});
const TABLE_SLOT: EmbedSlot = {
  kind: "attachment",
  ref: { attachmentIdentifier: "TABLE-1", typeUti: "com.apple.notes.table" },
};

function expectOk(result: ReturnType<typeof planEmbedRepresentations>) {
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function expectRefusal(result: ReturnType<typeof planEmbedRepresentations>, pattern: RegExp) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.reason, pattern);
}

test("a verbatim marker maps back to its placeholder; edits around it survive", () => {
  const localText = `Title\nedited intro\n${GALLERY_MARKER}\nedited outro`;
  const plan = expectOk(planEmbedRepresentations(localText, [GALLERY_SLOT], NO_FILES));
  assert.equal(plan.reconstructedBodyText, `Title\nedited intro\n${OBJECT_REPLACEMENT_CHARACTER}\nedited outro`);
  assert.deepEqual(plan.tables, []);
});

test("an unknown slot's marker round-trips the same way", () => {
  const localText = `Note\n${UNKNOWN_MARKER}\n`;
  const plan = expectOk(planEmbedRepresentations(localText, [UNKNOWN_SLOT], NO_FILES));
  assert.equal(plan.reconstructedBodyText, `Note\n${OBJECT_REPLACEMENT_CHARACTER}\n`);
});

test("markers and table blocks interleave in document order", () => {
  const table = renderMarkdownTable([["A", "B"]]);
  const localText = `Title\n${GALLERY_MARKER}\nbetween\n${table}\nafter`;
  const plan = expectOk(planEmbedRepresentations(localText, [GALLERY_SLOT, TABLE_SLOT], NO_FILES));
  assert.equal(
    plan.reconstructedBodyText,
    `Title\n${OBJECT_REPLACEMENT_CHARACTER}\nbetween\n${OBJECT_REPLACEMENT_CHARACTER}\nafter`,
  );
  assert.equal(plan.tables.length, 1);
  assert.equal(plan.tables[0]?.ref.attachmentIdentifier, "TABLE-1");
  assert.deepEqual(plan.tables[0]?.block.grid, [["A", "B"]]);
});

test("a table that pull couldn't decode is marker-represented, not table-represented", () => {
  const marker = formatEmbedMarker({ attachmentIdentifier: "TABLE-1", typeUti: "com.apple.notes.table" });
  const localText = `Prose\n${marker}\nmore prose`;
  const plan = expectOk(planEmbedRepresentations(localText, [TABLE_SLOT], NO_FILES));
  assert.equal(plan.reconstructedBodyText, `Prose\n${OBJECT_REPLACEMENT_CHARACTER}\nmore prose`);
  assert.deepEqual(plan.tables, []);
});

test("a deleted marker refuses the push", () => {
  expectRefusal(planEmbedRepresentations("Just prose, marker gone", [GALLERY_SLOT], NO_FILES), /marker.*missing/i);
});

test("an edited marker refuses the push", () => {
  const edited = GALLERY_MARKER.replace(">gallery<", ">my gallery<");
  expectRefusal(planEmbedRepresentations(`Text\n${edited}`, [GALLERY_SLOT], NO_FILES), /edited or is out of order/);
});

test("a duplicated marker refuses the push", () => {
  const localText = `A\n${GALLERY_MARKER}\nB\n${GALLERY_MARKER}`;
  expectRefusal(planEmbedRepresentations(localText, [GALLERY_SLOT], NO_FILES), /nothing behind it/);
});

test("reordered markers refuse the push", () => {
  const otherSlot: EmbedSlot = {
    kind: "attachment",
    ref: { attachmentIdentifier: "GALLERY-2", typeUti: "com.apple.notes.gallery" },
  };
  const otherMarker = formatEmbedMarker({ attachmentIdentifier: "GALLERY-2", typeUti: "com.apple.notes.gallery" });
  const localText = `A\n${otherMarker}\nB\n${GALLERY_MARKER}`;
  expectRefusal(planEmbedRepresentations(localText, [GALLERY_SLOT, otherSlot], NO_FILES), /edited or is out of order/);
});

test("a hand-added marker with nothing behind it refuses the push", () => {
  const localText = `Only prose\n${UNKNOWN_MARKER}`;
  expectRefusal(planEmbedRepresentations(localText, [], NO_FILES), /nothing behind it/);
});

test("a file attachment tracked from pull keeps the read-only refusal", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  const result = planEmbedRepresentations("![photo](attachments/photo.jpeg)", [fileSlot], new Set(["FILE-1"]));
  expectRefusal(result, /file attachment/);
});

test("an identified non-table slot with no marker and no tracked file refuses with the missing-marker reason", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  expectRefusal(planEmbedRepresentations("prose only", [fileSlot], NO_FILES), /marker.*is missing/);
});

test("an extra hand-typed table block refuses the push", () => {
  const table = renderMarkdownTable([["A"]]);
  const extra = renderMarkdownTable([["B"]]);
  const localText = `${table}\nprose\n${extra}`;
  expectRefusal(planEmbedRepresentations(localText, [TABLE_SLOT], NO_FILES), /can't tell which table/);
});

test("a missing table block refuses the push", () => {
  expectRefusal(planEmbedRepresentations("prose only", [TABLE_SLOT], NO_FILES), /can't tell which table/);
});

test("a table-only note reconstructs exactly like the old table path did", () => {
  const table = renderMarkdownTable([["Only", "Content"]]);
  const plan = expectOk(planEmbedRepresentations(table, [TABLE_SLOT], NO_FILES));
  assert.equal(plan.reconstructedBodyText, OBJECT_REPLACEMENT_CHARACTER);
});

test("two tables reconstruct in document order", () => {
  const first = renderMarkdownTable([["First"]]);
  const second = renderMarkdownTable([["Second", "Table"]]);
  const secondSlot: EmbedSlot = {
    kind: "attachment",
    ref: { attachmentIdentifier: "TABLE-2", typeUti: "com.apple.notes.table" },
  };
  const localText = `Intro\n${first}\nMiddle\n${second}\nOutro`;
  const plan = expectOk(planEmbedRepresentations(localText, [TABLE_SLOT, secondSlot], NO_FILES));
  assert.equal(
    plan.reconstructedBodyText,
    `Intro\n${OBJECT_REPLACEMENT_CHARACTER}\nMiddle\n${OBJECT_REPLACEMENT_CHARACTER}\nOutro`,
  );
  assert.deepEqual(
    plan.tables.map((t) => t.ref.attachmentIdentifier),
    ["TABLE-1", "TABLE-2"],
  );
});
