/**
 * The write-side formatting reconciler for Step 2 of the formatting plan:
 * given a note document whose *text* has already been brought to the
 * desired state (`applyTextEdit`), rewrites the attribute runs of every
 * paragraph whose rendered formatting differs from the desired model, and
 * applies the corresponding formatting op to the CRDT layer
 * (`applyFormattingOp`: op-clock bump + substring restamp).
 *
 * Edits are *clone-overlay* (design entry, dev log 2026-07-18T07:25):
 * untouched paragraphs keep their attribute runs verbatim; a changed
 * paragraph's runs are split at paragraph/span boundaries, each piece
 * cloned from its underlying run, and only the fields whose rendered
 * projection actually differs are overlaid. Everything this tool doesn't
 * render - colors, emphasis, fonts on unchanged bold spans, non-list
 * indents, dash-list style values, bare-URL link fields, attachmentInfo,
 * paragraph uuids, protobuf unknown fields - rides along untouched.
 * Comparisons happen in the same normalized projection the round-trip gate
 * uses, so e.g. a bare-URL link (link == its own text) is never "removed"
 * just because markdown represents it as plain text.
 */

import { clearField, clone, create, isFieldSet, toBinary } from "@bufbuild/protobuf";
import { randomUUID } from "node:crypto";
import {
  AttributeRunSchema,
  FontSchema,
  ParagraphStyleSchema,
  TodoSchema,
  type AttributeRun,
} from "./gen/topotext_pb.js";
import { applyFormattingOp, type NoteDocument } from "./noteDocument.js";
import {
  decodeNoteFormat,
  inlineStylesEqual,
  isListKind,
  normalizeSpans,
  paragraphProjectionsEqual,
  projectedKind,
  PLAIN_STYLE,
  type FormatParagraph,
  type InlineStyle,
  type ParagraphKind,
} from "./noteFormat.js";

export type ReconcileResult = { ok: true; changed: boolean } | { ok: false; reason: string };

const KIND_TO_STYLE: Record<ParagraphKind, number> = {
  title: 0,
  heading: 1,
  subheading: 2,
  body: 3,
  monospaced: 4,
  bulletList: 100,
  dashList: 101, // never written fresh - dash≡bullet in projection, so a kind change always writes 100
  numberedList: 102,
  todoList: 103,
};

/**
 * Reconciles `doc`'s formatting to `desired`. `doc.text` must already equal
 * the desired plain text (same paragraph structure) - the text splice runs
 * first, this second. Returns whether anything changed; refuses (rather
 * than guesses) if the document's current formatting can't be decoded or
 * doesn't line up with the desired paragraphs.
 */
export function reconcileNoteFormat(doc: NoteDocument, desired: readonly FormatParagraph[], replicaId: Uint8Array): ReconcileResult {
  const current = decodeNoteFormat(doc.text, doc.attributeRuns);
  if (current.status !== "ok") {
    return { ok: false, reason: current.reason };
  }
  if (current.paragraphs.length !== desired.length) {
    return { ok: false, reason: "the note's paragraphs don't line up with the edited text - refusing to guess" };
  }
  for (let i = 0; i < desired.length; i += 1) {
    if (current.paragraphs[i]!.text !== desired[i]!.text) {
      return { ok: false, reason: "the note's paragraphs don't line up with the edited text - refusing to guess" };
    }
  }

  // Todo identity dedup: a line inserted next to a checklist item inherits
  // that item's attribute run wholesale (`adjustAttributeRuns`), todo uuid
  // included - and two checklist items must never share an identity (Apple
  // merges check-state per uuid). Every later duplicate re-mints, matching
  // Apple's own client, which re-mints the disturbed *remainder* item on
  // splits (dev log 2026-07-17T10:16).
  const uuidOwners = new Set<string>();
  const needsFreshTodoUuid = new Set<number>();
  for (let i = 0; i < current.paragraphs.length; i += 1) {
    const paragraph = current.paragraphs[i]!;
    if (paragraph.kind !== "todoList" || desired[i]!.kind !== "todoList") {
      continue;
    }
    const uuid = todoUuidOfParagraph(doc, paragraph, i === current.paragraphs.length - 1);
    if (uuid === undefined || uuid.length === 0) {
      continue;
    }
    const key = Buffer.from(uuid).toString("hex");
    if (uuidOwners.has(key)) {
      needsFreshTodoUuid.add(i);
    } else {
      uuidOwners.add(key);
    }
  }

  const changedIndexes: number[] = [];
  for (let i = 0; i < desired.length; i += 1) {
    if (
      needsFreshTodoUuid.has(i) ||
      !paragraphProjectionsEqual(current.paragraphs[i]!, desired[i]!, current.paragraphs[i - 1], desired[i - 1])
    ) {
      changedIndexes.push(i);
    }
  }
  if (changedIndexes.length === 0) {
    return { ok: true, changed: false };
  }

  const plans = changedIndexes.map((index) =>
    buildParagraphPlan(current.paragraphs[index]!, desired[index]!, index === desired.length - 1, needsFreshTodoUuid.has(index)),
  );
  doc.attributeRuns = rewriteAttributeRuns(doc.attributeRuns, plans);
  applyFormattingOp(
    doc,
    plans.map((plan) => ({ start: plan.start, end: plan.end })),
    replicaId,
  );
  return { ok: true, changed: true };
}

// --- per-paragraph rewrite plans ---------------------------------------------

/** Everything needed to overlay one changed paragraph: its absolute char
 * range (including the trailing newline, which carries paragraph style),
 * both sides' normalized spans as absolute intervals, and the todo uuid to
 * use if the paragraph is (or becomes) a checklist item. */
interface ParagraphPlan {
  current: FormatParagraph;
  desired: FormatParagraph;
  start: number;
  end: number;
  currentSpans: SpanInterval[];
  desiredSpans: SpanInterval[];
  todoUuid: Uint8Array;
  /** The paragraph's inherited todo uuid duplicates an earlier item's - its
   * runs must take `todoUuid` even though nothing rendered differs. */
  forceFreshTodoUuid: boolean;
}

interface SpanInterval {
  start: number;
  end: number;
  style: InlineStyle;
}

function buildParagraphPlan(
  current: FormatParagraph,
  desired: FormatParagraph,
  isLastParagraph: boolean,
  forceFreshTodoUuid: boolean,
): ParagraphPlan {
  const start = current.start;
  const end = start + current.text.length + (isLastParagraph ? 0 : 1);
  return {
    current,
    desired,
    start,
    end,
    currentSpans: spanIntervals(current, end),
    desiredSpans: spanIntervals(desired, end),
    todoUuid: uuidBytes(),
    forceFreshTodoUuid,
  };
}

/** The todo uuid carried by the first run overlapping the paragraph's range
 * (all of a paragraph's runs share one), or undefined when none does. */
function todoUuidOfParagraph(doc: NoteDocument, paragraph: FormatParagraph, isLastParagraph: boolean): Uint8Array | undefined {
  const start = paragraph.start;
  const end = start + paragraph.text.length + (isLastParagraph ? 0 : 1);
  let offset = 0;
  for (const run of doc.attributeRuns) {
    const runStart = offset;
    const runEnd = offset + run.length;
    offset = runEnd;
    if (runStart < end && runEnd > start && run.paragraphStyle?.todo) {
      return run.paragraphStyle.todo.todoUUID;
    }
  }
  return undefined;
}

/** A paragraph's normalized spans as absolute [start, end) intervals; the
 * trailing newline (and any uncovered tail) extends the last span, or a
 * plain span if the paragraph is empty - the newline belongs to the
 * paragraph and takes its final inline styling, matching captured runs. */
function spanIntervals(paragraph: FormatParagraph, paragraphEnd: number): SpanInterval[] {
  const out: SpanInterval[] = [];
  let at = paragraph.start;
  for (const span of normalizeSpans(paragraph)) {
    if (span.length === 0) {
      continue;
    }
    out.push({ start: at, end: at + span.length, style: span });
    at += span.length;
  }
  const last = out[out.length - 1];
  if (last && last.end < paragraphEnd) {
    last.end = paragraphEnd;
  } else if (!last && paragraphEnd > at) {
    out.push({ start: at, end: paragraphEnd, style: PLAIN_STYLE });
  }
  return out;
}

function uuidBytes(): Uint8Array {
  return Uint8Array.from(randomUUID().replaceAll("-", "").match(/../g)!.map((byte) => parseInt(byte, 16)));
}

// --- attribute-run rewrite ---------------------------------------------------

function rewriteAttributeRuns(runs: readonly AttributeRun[], plans: readonly ParagraphPlan[]): AttributeRun[] {
  // Split boundaries: each changed paragraph's range edges plus both sides'
  // span boundaries within it. Runs outside every changed range pass
  // through untouched (same object).
  const boundaries = new Set<number>();
  for (const plan of plans) {
    boundaries.add(plan.start);
    boundaries.add(plan.end);
    for (const interval of [...plan.currentSpans, ...plan.desiredSpans]) {
      boundaries.add(interval.start);
      boundaries.add(interval.end);
    }
  }

  const out: AttributeRun[] = [];
  // Only pieces minted here may merge (and be mutated) afterwards -
  // untouched original runs pass through by reference and must stay intact.
  const rewritten = new Set<AttributeRun>();
  let offset = 0;
  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.length;
    offset = runEnd;
    const overlapsAnyPlan = plans.some((p) => runStart < p.end && runEnd > p.start);
    if (!overlapsAnyPlan) {
      out.push(run);
      continue;
    }
    // Cut the run at every boundary falling inside it, then overlay the
    // pieces that sit inside a changed paragraph.
    const cuts = [runStart, ...[...boundaries].filter((b) => b > runStart && b < runEnd).sort((a, b) => a - b), runEnd];
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const pieceStart = cuts[i]!;
      const pieceEnd = cuts[i + 1]!;
      const piece = clone(AttributeRunSchema, run);
      piece.length = pieceEnd - pieceStart;
      const piecePlan = plans.find((p) => pieceStart >= p.start && pieceEnd <= p.end);
      if (piecePlan) {
        overlayPiece(piece, piecePlan, pieceStart);
      }
      rewritten.add(piece);
      out.push(piece);
    }
  }
  return mergeEncodableEqualRuns(out, rewritten);
}

function overlayPiece(piece: AttributeRun, plan: ParagraphPlan, pieceStart: number): void {
  overlayParagraphStyle(piece, plan);
  const currentStyle = styleAt(plan.currentSpans, pieceStart);
  const desiredStyle = styleAt(plan.desiredSpans, pieceStart);
  if (!inlineStylesEqual(currentStyle, desiredStyle)) {
    overlayInlineStyle(piece, currentStyle, desiredStyle);
  }
}

function styleAt(intervals: readonly SpanInterval[], at: number): InlineStyle {
  return intervals.find((interval) => at >= interval.start && at < interval.end)?.style ?? PLAIN_STYLE;
}

/** Overlays paragraph-level fields. When the paragraph's projected kind is
 * unchanged, the existing paragraphStyle is kept (dash lists stay style
 * 101, iOS uuids stay put) and only the differing managed fields are set;
 * a kind change replaces it with a fresh web-client-shape style. */
function overlayParagraphStyle(piece: AttributeRun, plan: ParagraphPlan): void {
  const { current, desired } = plan;
  if (projectedKind(current.kind) !== projectedKind(desired.kind)) {
    piece.paragraphStyle = freshParagraphStyle(desired, piece, plan);
    return;
  }

  const needIndent = isListKind(desired.kind) && current.indent !== desired.indent;
  const needQuote = current.blockQuoteLevel !== desired.blockQuoteLevel;
  const needDone = desired.kind === "todoList" && (current.done ?? false) !== (desired.done ?? false);
  const needStart = desired.kind === "numberedList" && effectiveStart(current.startNumber) !== effectiveStart(desired.startNumber);
  const needIdentity = desired.kind === "todoList" && plan.forceFreshTodoUuid;
  if (!needIndent && !needQuote && !needDone && !needStart && !needIdentity) {
    return;
  }
  if (!piece.paragraphStyle) {
    // A body paragraph with no explicit style gaining e.g. a blockquote
    // level: write Body explicitly, the way the web client does.
    piece.paragraphStyle = create(ParagraphStyleSchema, { style: 3, alignment: 4 });
  }
  const ps = piece.paragraphStyle;
  if (needIndent) {
    ps.indent = desired.indent;
  }
  if (needQuote) {
    ps.blockQuoteLevel = desired.blockQuoteLevel;
  }
  if (needStart) {
    setStartNumber(ps, desired.startNumber);
  }
  // Repair pass for this tool's own early Step 2 writes: an *explicit*
  // startingListItemNumber of 0 makes Apple render the list from 0 (its own
  // client omits the field entirely - live-verified 2026-07-18), so any
  // rewrite of the paragraph drops it.
  if (isFieldSet(ps, PS_START_FIELD) && ps.startingListItemNumber === 0) {
    clearField(ps, PS_START_FIELD);
  }
  if (needIdentity) {
    ps.todo = create(TodoSchema, { todoUUID: plan.todoUuid, done: desired.done === true ? 1 : 0 });
  } else if (needDone) {
    if (ps.todo) {
      ps.todo.done = desired.done === true ? 1 : 0;
    } else {
      ps.todo = create(TodoSchema, { todoUUID: plan.todoUuid, done: desired.done === true ? 1 : 0 });
    }
  }
}

/** A fresh paragraph style in the shape the captured web client writes:
 * fields stamped explicitly (zeros included), alignment 4 (Natural), uuid
 * empty. The one exception is `startingListItemNumber`, which Apple's
 * client *omits* rather than zero-stamps - an explicit 0 renders the list
 * starting at 0 (live-verified 2026-07-18) - so it's only written for a
 * numbered group genuinely starting past 1. A checklist paragraph keeps
 * the run's existing todo uuid when it has one (a done-toggle isn't an
 * identity change), and otherwise gets the plan's freshly minted one -
 * Apple's own client re-mints freely, so this matches its bar (dev log
 * 2026-07-17T10:16). */
function freshParagraphStyle(desired: FormatParagraph, piece: AttributeRun, plan: ParagraphPlan) {
  return create(ParagraphStyleSchema, {
    style: KIND_TO_STYLE[projectedKind(desired.kind)],
    alignment: 4,
    writingDirection: 0,
    indent: isListKind(desired.kind) ? desired.indent : 0,
    ...(desired.kind === "todoList"
      ? {
          todo: create(TodoSchema, {
            todoUUID: (plan.forceFreshTodoUuid ? undefined : piece.paragraphStyle?.todo?.todoUUID) ?? plan.todoUuid,
            done: desired.done === true ? 1 : 0,
          }),
        }
      : {}),
    paragraphHints: 0,
    ...(desired.kind === "numberedList" && effectiveStart(desired.startNumber) !== 1
      ? { startingListItemNumber: desired.startNumber }
      : {}),
    blockQuoteLevel: desired.blockQuoteLevel,
    uuid: new Uint8Array(0),
  });
}

const PS_START_FIELD = ParagraphStyleSchema.fields.find((f) => f.localName === "startingListItemNumber")!;

function effectiveStart(startNumber: number): number {
  return startNumber === 0 ? 1 : startNumber;
}

/** Writes a numbered group's start, clearing the field for the default of 1
 * (matching Apple's omit-when-default shape) and setting it otherwise. */
function setStartNumber(ps: NonNullable<AttributeRun["paragraphStyle"]>, startNumber: number): void {
  if (effectiveStart(startNumber) === 1) {
    clearField(ps, PS_START_FIELD);
  } else {
    ps.startingListItemNumber = startNumber;
  }
}

/** Overlays only the inline fields whose normalized projection differs -
 * bold/italic share `fontHints` (and get the explicit `Font` object the
 * captured web client writes alongside), the rest are plain flag/string
 * fields. Fields that agree keep whatever the underlying run had. */
function overlayInlineStyle(piece: AttributeRun, current: InlineStyle, desired: InlineStyle): void {
  if (current.bold !== desired.bold || current.italic !== desired.italic) {
    piece.fontHints = (desired.bold ? 1 : 0) | (desired.italic ? 2 : 0);
    const fontName =
      desired.bold && desired.italic
        ? "SFUIText-BoldItalic"
        : desired.bold
          ? "SFUIText-Bold"
          : desired.italic
            ? "SFUIText-LightItalic"
            : undefined;
    piece.font = fontName === undefined ? undefined : create(FontSchema, { name: fontName });
  }
  if (current.strikethrough !== desired.strikethrough) {
    piece.strikethrough = desired.strikethrough ? 1 : 0;
  }
  if (current.underline !== desired.underline) {
    piece.underline = desired.underline ? 1 : 0;
  }
  if (current.link !== desired.link) {
    piece.link = desired.link;
  }
}

/** Merges back adjacent *rewritten* runs whose fields (other than length)
 * encode identically - the splitting above can produce runs of equal
 * formatting, and Apple's own saves freely normalize the run table the same
 * way. Untouched original runs never merge (they're shared objects and must
 * stay verbatim); an attachmentInfo run never merges either - its neighbors
 * either differ in fields or carry a different attachment identifier. */
function mergeEncodableEqualRuns(runs: readonly AttributeRun[], rewritten: ReadonlySet<AttributeRun>): AttributeRun[] {
  const out: AttributeRun[] = [];
  for (const run of runs) {
    const previous = out[out.length - 1];
    if (
      previous &&
      rewritten.has(previous) &&
      rewritten.has(run) &&
      previous.attachmentInfo === undefined &&
      run.attachmentInfo === undefined &&
      sameFieldsIgnoringLength(previous, run)
    ) {
      previous.length += run.length;
    } else {
      out.push(run);
    }
  }
  return out;
}

function sameFieldsIgnoringLength(a: AttributeRun, b: AttributeRun): boolean {
  const aCopy = clone(AttributeRunSchema, a);
  const bCopy = clone(AttributeRunSchema, b);
  aCopy.length = 0;
  bCopy.length = 0;
  const aBytes = toBinary(AttributeRunSchema, aCopy);
  const bBytes = toBinary(AttributeRunSchema, bCopy);
  return aBytes.length === bBytes.length && aBytes.every((byte, i) => byte === bBytes[i]);
}
