/**
 * The semantic formatting model between Apple's attribute runs and this
 * project's markdown rendering - Step 2 of the formatting plan (see the
 * Obsidian doc "icloud-notes-sync formatting", dev log 2026-07-18T07:25).
 *
 * `decodeNoteFormat` projects a note's `text + attributeRun` table onto the
 * dimensions this tool renders: paragraph kind (title/heading/subheading/
 * body/monospaced/lists/todo), list nesting depth, blockquote level, todo
 * state, and the inline bold/italic/strikethrough/underline/link spans.
 * Everything else Apple can express (color, emphasis/highlight, superscript,
 * alignment, fonts, per-paragraph uuids...) is deliberately *not* part of
 * the model: those fields render as plain text, stay byte-preserved on
 * untouched runs, and are overlaid back onto rewritten runs by the
 * reconciler - the accepted-limitations decision, 2026-07-17T10:01.
 *
 * Wire values (all confirmed on the 2026-07-17 formatting-evolution capture,
 * dev log 2026-07-17T10:16): style 0=Title 1=Heading 2=Subheading 3=Body
 * (also written explicitly; absent paragraphStyle means Body too) 4=Monospaced
 * 100=bullet list 101=dash list 102=numbered list 103=checklist (with
 * `todo{uuid, done}`); `indent` is list nesting; `fontHints` bit 1=bold
 * bit 2=italic; underline/strikethrough are plain flag fields; `link` covers
 * exactly the linked range.
 */

import { isFieldSet } from "@bufbuild/protobuf";
import { ParagraphStyleSchema, type AttributeRun, type ParagraphStyle } from "./gen/topotext_pb.js";

const PS_STYLE_FIELD = ParagraphStyleSchema.fields.find((f) => f.localName === "style")!;

export type ParagraphKind =
  | "title"
  | "heading"
  | "subheading"
  | "body"
  | "monospaced"
  | "bulletList"
  | "dashList"
  | "numberedList"
  | "todoList";

const STYLE_TO_KIND: Record<number, ParagraphKind> = {
  0: "title",
  1: "heading",
  2: "subheading",
  3: "body",
  4: "monospaced",
  100: "bulletList",
  101: "dashList",
  102: "numberedList",
  103: "todoList",
};

export interface InlineStyle {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  /** Link target URL; empty string means "not a link". */
  link: string;
}

export interface InlineSpan extends InlineStyle {
  /** UTF-16 length of the span within the paragraph's text. Spans cover a
   * paragraph's text exactly, in order (their lengths sum to `text.length`). */
  length: number;
}

export interface FormatParagraph {
  kind: ParagraphKind;
  /** List nesting depth (0 = top level). Carried for every kind but only
   * meaningful - and only round-trip-compared - on list kinds. */
  indent: number;
  blockQuoteLevel: number;
  /** Checklist state; only present on `todoList`. */
  done?: boolean;
  /** `startingListItemNumber`; only meaningful on `numberedList` (0 = default). */
  startNumber: number;
  /** Paragraph text, without its trailing newline. */
  text: string;
  spans: InlineSpan[];
  /** UTF-16 offset of `text` within the note's full text. */
  start: number;
}

export type DecodeNoteFormatResult =
  | { status: "ok"; paragraphs: FormatParagraph[] }
  | { status: "unsupported"; reason: string };

export const PLAIN_STYLE: InlineStyle = { bold: false, italic: false, strikethrough: false, underline: false, link: "" };

export function inlineStyleOfRun(run: AttributeRun): InlineStyle {
  return {
    bold: (run.fontHints & 1) !== 0,
    italic: (run.fontHints & 2) !== 0,
    strikethrough: run.strikethrough === 1,
    underline: run.underline === 1,
    link: run.link,
  };
}

export function inlineStylesEqual(a: InlineStyle, b: InlineStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strikethrough === b.strikethrough &&
    a.underline === b.underline &&
    a.link === b.link
  );
}

function paragraphKindOf(ps: ParagraphStyle | undefined): ParagraphKind | undefined {
  if (!ps || !isFieldSet(ps, PS_STYLE_FIELD)) {
    // Absent paragraphStyle - and a paragraphStyle carrying only e.g. an
    // indent, with no style field - both mean Body (dev log 2026-07-17T10:16).
    return "body";
  }
  return STYLE_TO_KIND[ps.style];
}

/**
 * Splits a note's text into per-line paragraphs and derives each one's
 * paragraph attributes and inline spans from the attribute runs covering it.
 *
 * Paragraph attributes come from the run covering the line's trailing
 * newline (a paragraph's style flows through its newline - confirmed on the
 * wire), falling back to the line's last character for the final,
 * unterminated line. Runs may span multiple lines (Apple merges adjacent
 * equal runs freely) or disagree within one (never observed; the newline's
 * run wins, matching where Apple's own editor anchors paragraph state).
 *
 * The run table may under-cover the text (tolerated: uncovered text is
 * plain Body, same policy as `decodeNoteEmbedSlots`) but must not overshoot
 * it - that means the runs and text disagree structurally, and the note is
 * reported unsupported rather than guessed at.
 */
export function decodeNoteFormat(text: string, attributeRuns: readonly AttributeRun[]): DecodeNoteFormatResult {
  let covered = 0;
  for (const run of attributeRuns) {
    covered += run.length;
  }
  if (covered > text.length) {
    return { status: "unsupported", reason: "the note's formatting runs overshoot its text" };
  }
  for (const run of attributeRuns) {
    if (run.paragraphStyle && paragraphKindOf(run.paragraphStyle) === undefined) {
      return {
        status: "unsupported",
        reason: `the note uses a paragraph style (${run.paragraphStyle.style}) this tool doesn't understand`,
      };
    }
  }

  // Run boundaries as absolute [start, end) intervals, in order. Zero-length
  // runs (never observed, but legal protobuf) can't contain any character,
  // so they're dropped from the interval list.
  interface RunInterval {
    run: AttributeRun;
    start: number;
    end: number;
  }
  const intervals: RunInterval[] = [];
  {
    let runOffset = 0;
    for (const run of attributeRuns) {
      if (run.length > 0) {
        intervals.push({ run, start: runOffset, end: runOffset + run.length });
      }
      runOffset += run.length;
    }
  }
  const runAt = (charIndex: number): RunInterval | undefined =>
    intervals.find((interval) => charIndex >= interval.start && charIndex < interval.end);

  const paragraphs: FormatParagraph[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const hasNewline = lineIndex < lines.length - 1;
    offset = lineEnd + (hasNewline ? 1 : 0);

    const anchorIndex = hasNewline ? lineEnd : lineEnd - 1;
    const anchorRun = anchorIndex >= lineStart ? runAt(anchorIndex)?.run : undefined;
    const ps = anchorRun?.paragraphStyle;
    const kind = paragraphKindOf(ps) ?? "body";

    const spans: InlineSpan[] = [];
    for (let at = lineStart; at < lineEnd; ) {
      const interval = runAt(at);
      const spanEnd = interval === undefined ? lineEnd : Math.min(lineEnd, interval.end);
      const style = interval === undefined ? PLAIN_STYLE : inlineStyleOfRun(interval.run);
      const previous = spans[spans.length - 1];
      if (previous && inlineStylesEqual(previous, style)) {
        previous.length += spanEnd - at;
      } else {
        spans.push({ ...style, length: spanEnd - at });
      }
      at = spanEnd;
    }

    paragraphs.push({
      kind,
      indent: ps?.indent ?? 0,
      blockQuoteLevel: ps?.blockQuoteLevel ?? 0,
      ...(kind === "todoList" ? { done: ps?.todo?.done === 1 } : {}),
      startNumber: ps?.startingListItemNumber ?? 0,
      text: line,
      spans,
      start: lineStart,
    });
  }
  return { status: "ok", paragraphs };
}

// --- round-trip projection ---------------------------------------------------

/** A span in canonical projection form: dash lists collapse into bullet
 * lists; a link whose target is exactly its own covered text collapses to
 * "not a link" (Apple auto-links bare URLs; GFM re-derives them from plain
 * text, and backslash escapes can't suppress that - see `markdownTable.ts` -
 * so bare-URL links round-trip as plain text by design); monospaced
 * paragraphs drop their inline styling entirely (fenced code blocks are
 * lossy inside - decided 2026-07-17T07:47); and the delimiter-notated
 * styles (bold/italic/strikethrough) retreat off whitespace at their edges,
 * because CommonMark's flanking rules make `* text*` not parse as emphasis -
 * styling a boundary space is visually indistinguishable anyway. */
export function normalizeSpans(paragraph: FormatParagraph): InlineSpan[] {
  if (paragraph.kind === "monospaced") {
    return paragraph.text.length === 0 ? [] : [{ ...PLAIN_STYLE, length: paragraph.text.length }];
  }
  const out: InlineSpan[] = [];
  let at = 0;
  for (const span of paragraph.spans) {
    const coveredText = paragraph.text.slice(at, at + span.length);
    at += span.length;
    const normalized: InlineSpan = { ...span, link: span.link === coveredText ? "" : span.link };
    const previous = out[out.length - 1];
    if (previous && inlineStylesEqual(previous, normalized)) {
      previous.length += normalized.length;
    } else {
      out.push(normalized);
    }
  }
  // A second effective-link pass: adjacent runs each carrying the full URL as
  // their link merge above only if their raw attrs matched; re-check whether
  // the merged span now covers exactly its link text.
  let start = 0;
  for (const span of out) {
    if (span.link !== "" && paragraph.text.slice(start, start + span.length) === span.link) {
      span.link = "";
    }
    start += span.length;
  }
  return mergeAdjacentEqualSpans(trimDelimiterStylesOffWhitespace(paragraph.text, out));
}

const DELIMITER_DIMENSIONS = ["bold", "italic", "strikethrough"] as const;

/** Per-character sweep turning bold/italic/strikethrough off on whitespace
 * at the edges of each styled interval (see `normalizeSpans`). Underline
 * (`<u>`, no flanking rules) and links (bracket syntax, ditto) keep their
 * exact extents. */
function trimDelimiterStylesOffWhitespace(text: string, spans: readonly InlineSpan[]): InlineSpan[] {
  if (spans.length === 0 || !DELIMITER_DIMENSIONS.some((dim) => spans.some((span) => span[dim]))) {
    return [...spans];
  }
  const styles: InlineStyle[] = [];
  for (const span of spans) {
    for (let i = 0; i < span.length; i += 1) {
      styles.push(span);
    }
  }
  const isWhitespace = (index: number): boolean => /\s/.test(text[index] ?? "");

  for (const dimension of DELIMITER_DIMENSIONS) {
    let i = 0;
    while (i < styles.length) {
      if (!styles[i]![dimension]) {
        i += 1;
        continue;
      }
      let end = i;
      while (end < styles.length && styles[end]![dimension]) {
        end += 1;
      }
      for (let k = i; k < end && isWhitespace(k); k += 1) {
        styles[k] = { ...styles[k]!, [dimension]: false };
      }
      for (let k = end - 1; k >= i && isWhitespace(k); k -= 1) {
        styles[k] = { ...styles[k]!, [dimension]: false };
      }
      i = end;
    }
  }

  const out: InlineSpan[] = [];
  for (const style of styles) {
    const previous = out[out.length - 1];
    if (previous && inlineStylesEqual(previous, style)) {
      previous.length += 1;
    } else {
      out.push({ ...style, link: style.link, length: 1 });
    }
  }
  return out;
}

function mergeAdjacentEqualSpans(spans: readonly InlineSpan[]): InlineSpan[] {
  const out: InlineSpan[] = [];
  for (const span of spans) {
    const previous = out[out.length - 1];
    if (previous && inlineStylesEqual(previous, span)) {
      previous.length += span.length;
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

const LIST_KINDS: ReadonlySet<ParagraphKind> = new Set(["bulletList", "dashList", "numberedList", "todoList"]);

export function isListKind(kind: ParagraphKind): boolean {
  return LIST_KINDS.has(kind);
}

export function projectedKind(kind: ParagraphKind): ParagraphKind {
  return kind === "dashList" ? "bulletList" : kind;
}

/** The effective first number a rendered numbered list would carry - only
 * compared at the start of a run of numbered items, since markdown re-derives
 * every later item's number by incrementing. */
function effectiveStartNumber(paragraph: FormatParagraph): number {
  return paragraph.startNumber === 0 ? 1 : paragraph.startNumber;
}

/**
 * Whether two paragraphs at the same position agree on every dimension this
 * tool renders. The previous paragraph on each side feeds the numbered-list
 * group-start rule: only a group's first item compares its effective start
 * number, since markdown re-derives every later item's number by counting.
 */
export function paragraphProjectionsEqual(
  a: FormatParagraph,
  b: FormatParagraph,
  previousA: FormatParagraph | undefined,
  previousB: FormatParagraph | undefined,
): boolean {
  if (projectedKind(a.kind) !== projectedKind(b.kind) || a.text !== b.text) {
    return false;
  }
  if (a.blockQuoteLevel !== b.blockQuoteLevel) {
    return false;
  }
  if (isListKind(a.kind) && a.indent !== b.indent) {
    return false;
  }
  if (a.kind === "todoList" && (a.done ?? false) !== (b.done ?? false)) {
    return false;
  }
  if (a.kind === "numberedList") {
    const startsGroupA = !previousA || previousA.kind !== "numberedList" || previousA.indent !== a.indent;
    const startsGroupB = !previousB || previousB.kind !== "numberedList" || previousB.indent !== b.indent;
    if (startsGroupA !== startsGroupB) {
      return false;
    }
    if (startsGroupA && effectiveStartNumber(a) !== effectiveStartNumber(b)) {
      return false;
    }
  }
  const spansA = normalizeSpans(a);
  const spansB = normalizeSpans(b);
  if (spansA.length !== spansB.length) {
    return false;
  }
  for (let j = 0; j < spansA.length; j += 1) {
    if (spansA[j]!.length !== spansB[j]!.length || !inlineStylesEqual(spansA[j]!, spansB[j]!)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether two decoded formats agree on every dimension this tool renders -
 * the round-trip gate for Step 2 (`parse(render(doc))` must reproduce the
 * model). Compared on the *projection*: dimensions we deliberately don't
 * render (colors, fonts, non-list indents, dash-vs-bullet, bare-URL links,
 * inline styling inside monospaced blocks...) don't participate.
 */
export function formatsRoundTripEqual(a: readonly FormatParagraph[], b: readonly FormatParagraph[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (!paragraphProjectionsEqual(a[i]!, b[i]!, a[i - 1], b[i - 1])) {
      return false;
    }
  }
  return true;
}
