/**
 * Write-side markdown parser for Step 2 of the formatting plan: turns a
 * local file's markdown (after embed markers and table blocks have been
 * extracted and replaced with U+FFFC placeholders) back into the semantic
 * `FormatParagraph` model that `renderNoteMarkdown` renders from.
 *
 * All tokenizing goes through remark (+GFM) - same plugin set as the
 * renderer, so construct recognition and escaping agree. What this module
 * adds on top of the mdast tree is *line bookkeeping* via source positions,
 * because the model is line-oriented while markdown is block-oriented. The
 * tree walk records which paragraph(s) each source line produced (and which
 * lines are pure syntax - code fences, setext underlines); a final sweep
 * emits everything in source-line order, turning every line no construct
 * claimed into a real empty paragraph at its own blockquote depth. That
 * sweep is what preserves Apple's empty paragraphs everywhere they occur -
 * between blocks, inside blockquotes, and *between list items* (remark
 * absorbs a blank line between two lists into one loose list; the sweep
 * puts the empty paragraph back where the source had it).
 *
 * Other line-level rules:
 * - Multi-line paragraph nodes (soft breaks, lazy continuations) split back
 *   into per-line paragraphs: the first line keeps its container's meaning
 *   (list item, quote, ...), continuation lines become Body paragraphs
 *   whose blockquote level is re-derived from the raw line's own `>`
 *   markers - a lazily continued line carries no markers and correctly
 *   lands outside the quote.
 * - GFM autolink literals (bare URLs remark turns into links; backslash
 *   escapes can't suppress it - see `markdownTable.ts`) are *not* link
 *   spans: only bracket/angle syntax is. Apple's own bare-URL links
 *   round-trip as plain text by the same rule (`normalizeSpans`).
 * - Constructs Apple Notes can't express degrade in one of two ways:
 *   inline constructs (inline code, images, ...) contribute their raw
 *   source text literally, like `markdownTable.ts`'s cell fallback; block
 *   constructs (thematic breaks, html blocks, deep headings, ...) refuse
 *   the parse with a precise reason - push surfaces it, and the read-side
 *   round-trip gate never produces them.
 */

import type { Heading, List, Paragraph, PhrasingContent, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  inlineStylesEqual,
  PLAIN_STYLE,
  type FormatParagraph,
  type InlineSpan,
  type InlineStyle,
  type ParagraphKind,
} from "./noteFormat.js";

const processor = unified().use(remarkParse).use(remarkGfm, { tablePipeAlign: false });

export type ParseNoteMarkdownResult =
  | { status: "ok"; paragraphs: FormatParagraph[]; text: string }
  | { status: "unsupported"; reason: string };

/** Internal control flow for "this markdown can't be represented in Apple
 * Notes" - caught at the top level and returned as a reason string. */
class Unsupported extends Error {}

export function parseNoteMarkdown(markdown: string): ParseNoteMarkdownResult {
  const lines = markdown.split("\n");
  const root = processor.parse(markdown);
  const parser = new Parser(markdown, lines);
  let paragraphs: FormatParagraph[];
  try {
    for (const child of root.children) {
      parser.walkBlock(child, 0);
    }
    paragraphs = parser.sweep();
  } catch (cause) {
    if (cause instanceof Unsupported) {
      return { status: "unsupported", reason: cause.message };
    }
    throw cause;
  }
  let offset = 0;
  for (const paragraph of paragraphs) {
    paragraph.start = offset;
    offset += paragraph.text.length + 1;
  }
  return { status: "ok", paragraphs, text: paragraphs.map((paragraph) => paragraph.text).join("\n") };
}

/** A run of same-styled text within one line, or a line boundary. */
type InlinePiece = { text: string; style: InlineStyle } | "linebreak";

interface ParagraphSeed {
  kind: ParagraphKind;
  indent: number;
  done?: boolean;
  startNumber: number;
}

const BODY_SEED: ParagraphSeed = { kind: "body", indent: 0, startNumber: 0 };

class Parser {
  /** Per source line (0-based): the paragraphs that line produced, or
   * "syntax" for lines that are pure notation (fence delimiters, setext
   * underlines). Untouched lines become empty paragraphs in `sweep`. */
  private readonly lineOutput: (FormatParagraph[] | "syntax" | undefined)[];

  constructor(
    private readonly source: string,
    private readonly lines: readonly string[],
  ) {
    this.lineOutput = new Array(lines.length).fill(undefined);
  }

  /** Emits everything in source-line order; a line no construct claimed
   * must be blank apart from blockquote markers and becomes a real empty
   * paragraph at its marker depth. */
  sweep(): FormatParagraph[] {
    const out: FormatParagraph[] = [];
    for (let index = 0; index < this.lines.length; index += 1) {
      const recorded = this.lineOutput[index];
      if (recorded === "syntax") {
        continue;
      }
      if (recorded !== undefined) {
        out.push(...recorded);
        continue;
      }
      const raw = this.lines[index]!;
      if (stripQuoteMarkers(raw).trim() !== "") {
        throw new Unsupported(`line ${index + 1} wasn't recognized as any markdown construct this tool can represent`);
      }
      out.push(makeParagraph("body", countQuoteMarkers(raw), "", [], BODY_SEED));
    }
    return out;
  }

  private record(lineNumber: number, paragraph: FormatParagraph): void {
    const index = lineNumber - 1;
    const existing = this.lineOutput[index];
    if (existing === undefined || existing === "syntax") {
      this.lineOutput[index] = [paragraph];
    } else {
      existing.push(paragraph);
    }
  }

  private markSyntax(lineNumber: number): void {
    const index = lineNumber - 1;
    if (this.lineOutput[index] === undefined) {
      this.lineOutput[index] = "syntax";
    }
  }

  walkBlock(node: RootContent, blockQuoteLevel: number): void {
    switch (node.type) {
      case "paragraph":
        this.recordParagraphLines(node, blockQuoteLevel, BODY_SEED);
        return;
      case "heading":
        this.recordHeading(node, blockQuoteLevel);
        return;
      case "code":
        this.recordCode(node.value, nodeLines(node), blockQuoteLevel);
        return;
      case "blockquote":
        for (const child of node.children) {
          this.walkBlock(child, blockQuoteLevel + 1);
        }
        return;
      case "list":
        this.walkList(node, blockQuoteLevel, 0);
        return;
      case "thematicBreak":
        throw new Unsupported("a thematic break (---/***) has no Apple Notes equivalent");
      case "html":
        throw new Unsupported(
          "raw HTML blocks can't be represented in Apple Notes (underline's <u> tags are supported inline, within a line of text)",
        );
      case "table":
        throw new Unsupported("a markdown table doesn't correspond to any table in this note");
      default:
        throw new Unsupported(`markdown construct "${node.type}" has no Apple Notes equivalent`);
    }
  }

  private recordHeading(node: Heading, blockQuoteLevel: number): void {
    const kind: ParagraphKind | undefined =
      node.depth === 1 ? "title" : node.depth === 2 ? "heading" : node.depth === 3 ? "subheading" : undefined;
    if (kind === undefined) {
      throw new Unsupported(
        `a depth-${node.depth} heading has no Apple Notes equivalent (only # through ### map to Title/Heading/Subheading)`,
      );
    }
    // Headings are single-line in Apple's model; a hand-written setext
    // heading's soft-wrapped lines collapse into one with spaces, and its
    // extra source lines (content wraps, the ===/--- underline) are syntax.
    const pieces = this.flattenInline(node.children, PLAIN_STYLE, { underline: 0 });
    const joined = pieces.map((piece) => (piece === "linebreak" ? { text: " ", style: PLAIN_STYLE } : piece));
    const { text, spans } = lineFromPieces(joined);
    const position = nodeLines(node);
    this.record(position.start, makeParagraph(kind, blockQuoteLevel, text, spans, BODY_SEED));
    for (let line = position.start + 1; line <= position.end; line += 1) {
      this.markSyntax(line);
    }
  }

  /** A fenced block's delimiter lines are syntax and its value lines map
   * 1:1 onto the lines between them; an indented code block has no
   * delimiters and starts on the node's own first line. */
  private recordCode(value: string, position: { start: number; end: number }, blockQuoteLevel: number): void {
    const contentLines = value.split("\n");
    const sourceSpan = position.end - position.start + 1;
    const fenced = sourceSpan >= contentLines.length + 1; // opening fence, maybe an unclosed end
    const contentStart = fenced ? position.start + 1 : position.start;
    for (let line = position.start; line <= position.end; line += 1) {
      this.markSyntax(line);
    }
    for (let i = 0; i < contentLines.length; i += 1) {
      this.record(contentStart + i, makeParagraph("monospaced", blockQuoteLevel, contentLines[i]!, [], BODY_SEED));
    }
  }

  private walkList(list: List, blockQuoteLevel: number, indent: number): void {
    for (let itemIndex = 0; itemIndex < list.children.length; itemIndex += 1) {
      const item = list.children[itemIndex]!;
      const checked = item.checked;

      // GFM can't express an empty checklist item, so the renderer writes
      // its checkbox as raw text on a bare `- [ ]`/`- [x]` line (see
      // `renderNoteMarkdown`); GFM sees a plain bullet whose text is
      // "[ ]"/"[x]". Recognize that exact unescaped line shape - a real
      // bullet whose text is literally "[ ]" renders as `- \[ ]` and
      // doesn't match.
      const itemStartLine = nodeLines(item).start;
      const emptyTodoMatch =
        checked == null && list.ordered !== true
          ? /^[ \t>]*[-*+][ \t]+\[([ xX])\][ \t]*$/.exec(this.lines[itemStartLine - 1] ?? "")
          : null;
      if (emptyTodoMatch && nodeLines(item).end === itemStartLine) {
        const seed: ParagraphSeed = { kind: "todoList", indent, done: emptyTodoMatch[1] !== " ", startNumber: 0 };
        this.record(itemStartLine, makeParagraph("todoList", blockQuoteLevel, "", [], seed));
        continue;
      }

      const seed: ParagraphSeed = {
        kind: checked === true || checked === false ? "todoList" : list.ordered === true ? "numberedList" : "bulletList",
        indent,
        ...(checked === true || checked === false ? { done: checked } : {}),
        startNumber: itemIndex === 0 && list.ordered === true && (list.start ?? 1) !== 1 ? list.start! : 0,
      };

      if (item.children.length === 0) {
        this.record(nodeLines(item).start, makeParagraph(seed.kind, blockQuoteLevel, "", [], seed));
        continue;
      }
      let firstParagraphSeen = false;
      for (const child of item.children) {
        if (child.type === "paragraph") {
          // The item's first paragraph starts on the marker line and carries
          // the item's meaning; later paragraphs in a (loose) item have no
          // marker of their own and degrade to Body lines.
          this.recordParagraphLines(child, blockQuoteLevel, firstParagraphSeen ? BODY_SEED : seed);
          firstParagraphSeen = true;
        } else if (child.type === "list") {
          this.walkList(child, blockQuoteLevel, indent + 1);
        } else {
          throw new Unsupported(`markdown construct "${child.type}" inside a list item has no Apple Notes equivalent`);
        }
      }
    }
  }

  /**
   * Records one paragraph per source line of a paragraph node. The first
   * line takes `seed` (the container's meaning); continuation lines - soft
   * breaks, hard breaks, and lazy continuations alike - become Body
   * paragraphs whose blockquote level is re-read from the raw line's own
   * `>` markers (a lazy line has none and lands at level 0). If the inline
   * content's line count disagrees with the node's source span (only
   * possible with newline character references, which the renderer never
   * writes), everything lands on the node's lines in order with the
   * container's quote level.
   */
  private recordParagraphLines(node: Paragraph, blockQuoteLevel: number, seed: ParagraphSeed): void {
    const pieces = this.flattenInline(node.children, PLAIN_STYLE, { underline: 0 });
    const pieceLines: InlinePiece[][] = [[]];
    for (const piece of pieces) {
      if (piece === "linebreak") {
        pieceLines.push([]);
      } else {
        pieceLines[pieceLines.length - 1]!.push(piece);
      }
    }
    const position = nodeLines(node);
    const sourceLineCount = position.end - position.start + 1;
    const positionsReliable = pieceLines.length === sourceLineCount;

    for (let lineIndex = 0; lineIndex < pieceLines.length; lineIndex += 1) {
      const { text, spans } = lineFromPieces(pieceLines[lineIndex]!);
      const sourceLine = position.start + Math.min(lineIndex, sourceLineCount - 1);
      if (lineIndex === 0) {
        this.record(sourceLine, makeParagraph(seed.kind, blockQuoteLevel, text, spans, seed));
      } else {
        const rawLine = positionsReliable ? this.lines[sourceLine - 1] : undefined;
        const level = rawLine === undefined ? blockQuoteLevel : countQuoteMarkers(rawLine);
        this.record(sourceLine, makeParagraph("body", level, text, spans, BODY_SEED));
      }
    }
  }

  /**
   * Flattens phrasing content into same-styled text pieces and line breaks.
   * `<u>`/`</u>` html toggles underline (tracked as depth in `state`, since
   * open and close are sibling nodes); other inline constructs Apple can't
   * express (inline code, images, other html) contribute their raw source
   * text - same degradation as `markdownTable.ts`'s cell fallback. A `link`
   * node only produces a link span for explicit `[..](..)`/`<..>` syntax;
   * GFM autolink literals (recognizable by their missing or bracket-less
   * source position) stay plain text.
   */
  private flattenInline(children: readonly PhrasingContent[], style: InlineStyle, state: { underline: number }): InlinePiece[] {
    const out: InlinePiece[] = [];
    for (const child of children) {
      switch (child.type) {
        case "text": {
          const parts = child.value.split("\n");
          for (let i = 0; i < parts.length; i += 1) {
            if (i > 0) {
              out.push("linebreak");
            }
            if (parts[i]!.length > 0) {
              out.push({ text: parts[i]!, style: { ...style, underline: state.underline > 0 } });
            }
          }
          break;
        }
        case "strong":
          out.push(...this.flattenInline(child.children, { ...style, bold: true }, state));
          break;
        case "emphasis":
          out.push(...this.flattenInline(child.children, { ...style, italic: true }, state));
          break;
        case "delete":
          out.push(...this.flattenInline(child.children, { ...style, strikethrough: true }, state));
          break;
        case "link": {
          const startOffset = child.position?.start.offset;
          const syntaxChar = startOffset === undefined ? undefined : this.source[startOffset];
          const explicit = syntaxChar === "[" || syntaxChar === "<";
          out.push(...this.flattenInline(child.children, explicit ? { ...style, link: child.url } : style, state));
          break;
        }
        case "html": {
          if (/^<u>$/i.test(child.value)) {
            state.underline += 1;
          } else if (/^<\/u>$/i.test(child.value)) {
            state.underline = Math.max(0, state.underline - 1);
          } else {
            out.push({ text: child.value, style: { ...style, underline: state.underline > 0 } });
          }
          break;
        }
        case "break":
          out.push("linebreak");
          break;
        default: {
          const raw = this.rawSlice(child);
          if (raw === undefined) {
            throw new Unsupported(`inline markdown construct "${child.type}" has no Apple Notes equivalent`);
          }
          out.push({ text: raw, style: { ...style, underline: state.underline > 0 } });
          break;
        }
      }
    }
    return out;
  }

  private rawSlice(node: PhrasingContent): string | undefined {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start === undefined || end === undefined ? undefined : this.source.slice(start, end);
  }
}

function makeParagraph(
  kind: ParagraphKind,
  blockQuoteLevel: number,
  text: string,
  spans: InlineSpan[],
  seed: ParagraphSeed,
): FormatParagraph {
  return {
    kind,
    indent: kind === seed.kind ? seed.indent : 0,
    blockQuoteLevel,
    ...(kind === "todoList" && seed.done !== undefined ? { done: seed.done } : {}),
    startNumber: kind === seed.kind ? seed.startNumber : 0,
    text,
    spans,
    start: 0, // assigned after the walk completes
  };
}

function lineFromPieces(pieces: readonly ({ text: string; style: InlineStyle } | "linebreak")[]): {
  text: string;
  spans: InlineSpan[];
} {
  let text = "";
  const spans: InlineSpan[] = [];
  for (const piece of pieces) {
    if (piece === "linebreak") {
      continue;
    }
    text += piece.text;
    const previous = spans[spans.length - 1];
    if (previous && inlineStylesEqual(previous, piece.style)) {
      previous.length += piece.text.length;
    } else {
      spans.push({ ...piece.style, length: piece.text.length });
    }
  }
  return { text, spans };
}

/** 1-based inclusive source lines of a node. Remark always provides
 * positions for block nodes it parsed from source; a missing position is a
 * programming error, not a user input problem. */
function nodeLines(node: { type: string; position?: { start: { line: number }; end: { line: number } } | undefined }): {
  start: number;
  end: number;
} {
  const start = node.position?.start.line;
  const end = node.position?.end.line;
  if (start === undefined || end === undefined) {
    throw new Error(`markdown ${node.type} node is missing its source position`);
  }
  return { start, end };
}

/** Number of leading `>` blockquote markers on a raw source line (each may
 * be preceded by up to three spaces of indentation, per CommonMark). */
export function countQuoteMarkers(rawLine: string): number {
  let count = 0;
  let at = 0;
  for (;;) {
    let spaces = 0;
    while (spaces < 3 && rawLine[at + spaces] === " ") {
      spaces += 1;
    }
    if (rawLine[at + spaces] !== ">") {
      return count;
    }
    at += spaces + 1;
    count += 1;
    if (rawLine[at] === " ") {
      at += 1;
    }
  }
}

function stripQuoteMarkers(rawLine: string): string {
  let at = 0;
  for (;;) {
    let spaces = 0;
    while (spaces < 3 && rawLine[at + spaces] === " ") {
      spaces += 1;
    }
    if (rawLine[at + spaces] !== ">") {
      return rawLine.slice(at);
    }
    at += spaces + 1;
    if (rawLine[at] === " ") {
      at += 1;
    }
  }
}
