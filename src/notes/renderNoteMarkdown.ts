/**
 * Read-side markdown renderer for Step 2 of the formatting plan: turns the
 * semantic model `decodeNoteFormat` extracts from a note into the markdown
 * written to the local file (before embed placeholders are substituted -
 * U+FFFC characters pass through as ordinary text).
 *
 * The renderer is *line-oriented*: Apple's text model is one paragraph per
 * newline-terminated line, empty paragraphs (including consecutive ones) are
 * real content, and `remark-stringify` cannot represent those - it joins
 * block nodes with exactly one blank line. So this module owns the file's
 * newline skeleton itself (one file line per note paragraph; blank file
 * lines are real empty paragraphs; blocks are joined with a single "\n",
 * never a blank line), and delegates everything markdown-*syntactic* -
 * heading/list/checkbox/fence notation, inline emphasis, and especially
 * escaping - to mdast + `remark-stringify`, per the no-hand-rolled-markdown
 * ground rule (2026-07-16). See the design entry, dev log 2026-07-18T07:25.
 *
 * The write-side parser (`parseNoteMarkdown.ts`) reverses this by walking
 * remark-parse's tree with source positions; `classifyNoteRecord` runs the
 * full render→parse round trip on every note and refuses to mark a note
 * publishable when the projection doesn't survive (e.g. CommonMark
 * adjacency artifacts like a body line directly above a `5.`-numbered list).
 */

import type {
  BlockContent,
  Blockquote,
  Code,
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { normalizeSpans, type FormatParagraph, type InlineSpan, type ParagraphKind } from "./noteFormat.js";

/** Same plugin set as the parser and `markdownTable.ts`, so escaping
 * decisions and construct recognition always agree. */
const processor = unified().use(remarkParse).use(remarkGfm, { tablePipeAlign: false }).use(remarkStringify, { bullet: "-" });

const HEADING_DEPTHS: Partial<Record<ParagraphKind, 1 | 2 | 3>> = {
  title: 1,
  heading: 2,
  subheading: 3,
};

export function renderNoteMarkdown(paragraphs: readonly FormatParagraph[]): string {
  const lines: string[] = [];
  let i = 0;
  while (i < paragraphs.length) {
    const paragraph = paragraphs[i]!;
    const bq = paragraph.blockQuoteLevel;

    if (paragraph.kind === "monospaced") {
      let end = i;
      while (end < paragraphs.length && paragraphs[end]!.kind === "monospaced" && paragraphs[end]!.blockQuoteLevel === bq) {
        end += 1;
      }
      const code: Code = { type: "code", value: paragraphs.slice(i, end).map((p) => p.text).join("\n") };
      pushBlockLines(lines, code, bq);
      i = end;
      continue;
    }

    if (isListParagraph(paragraph)) {
      let end = i;
      while (end < paragraphs.length && isListParagraph(paragraphs[end]!) && paragraphs[end]!.blockQuoteLevel === bq) {
        end += 1;
      }
      for (const list of buildListNodes(paragraphs.slice(i, end))) {
        pushBlockLines(lines, list, bq);
      }
      i = end;
      continue;
    }

    const depth = HEADING_DEPTHS[paragraph.kind];
    if (depth !== undefined) {
      const heading: Heading = { type: "heading", depth, children: phrasingFromParagraph(paragraph) };
      pushBlockLines(lines, heading, bq);
      i += 1;
      continue;
    }

    // Body. An empty body line is written literally (a blank line, or bare
    // `>` markers at blockquote level) rather than stringified - remark has
    // no notion of an empty paragraph.
    if (paragraph.text.length === 0) {
      lines.push(bq === 0 ? "" : ">".repeat(bq));
    } else {
      const body: Paragraph = { type: "paragraph", children: phrasingFromParagraph(paragraph) };
      pushBlockLines(lines, body, bq);
    }
    i += 1;
  }
  return lines.join("\n");
}

function isListParagraph(paragraph: FormatParagraph): boolean {
  return (
    paragraph.kind === "bulletList" ||
    paragraph.kind === "dashList" ||
    paragraph.kind === "numberedList" ||
    paragraph.kind === "todoList"
  );
}

/** Stringifies one block (wrapped in `blockQuoteLevel` blockquotes) and
 * appends its lines. The stringified block must not contain blank lines -
 * every construct built here is tight - so its line count is exactly its
 * paragraph count; a construct that violates that is still *parsed*
 * correctly (the parser ignores intra-list blank lines), it just fails the
 * per-note round-trip gate instead of corrupting anything. */
function pushBlockLines(lines: string[], node: BlockContent, blockQuoteLevel: number): void {
  let wrapped: BlockContent = node;
  for (let level = 0; level < blockQuoteLevel; level += 1) {
    const quote: Blockquote = { type: "blockquote", children: [wrapped] };
    wrapped = quote;
  }
  const root: Root = { type: "root", children: [wrapped] };
  const rendered = processor.stringify(root).replace(/\n$/, "");
  lines.push(...rendered.split("\n"));
}

// --- lists -------------------------------------------------------------------

/**
 * Builds mdast list structure for a run of consecutive list paragraphs:
 * nesting from `indent`, ordered lists from `numberedList` (with `start`
 * from the group head's `startingListItemNumber`), GFM checkboxes from
 * `todoList`. Bullet and dash lists both render as `-` items (fidelity
 * mapping; the model's projection collapses them, and untouched dash
 * paragraphs keep style 101 on the wire). A type switch at the same depth
 * opens a sibling list; an indent jump deeper than one level nests as far
 * as the structure allows and is caught by the round-trip gate (Apple's own
 * editors only indent one step at a time).
 */
function buildListNodes(paragraphs: readonly FormatParagraph[]): List[] {
  const result: List[] = [];
  const stack: { list: List; indent: number }[] = [];

  for (const paragraph of paragraphs) {
    const ordered = paragraph.kind === "numberedList";
    while (stack.length > 0 && stack[stack.length - 1]!.indent > paragraph.indent) {
      stack.pop();
    }
    let top = stack[stack.length - 1];
    if (top && top.indent === paragraph.indent && top.list.ordered !== ordered) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (!top || top.indent < paragraph.indent) {
      const list: List = {
        type: "list",
        ordered,
        spread: false,
        children: [],
        ...(ordered ? { start: paragraph.startNumber === 0 ? 1 : paragraph.startNumber } : {}),
      };
      const parentItem = top?.list.children[top.list.children.length - 1];
      if (parentItem) {
        parentItem.children.push(list);
      } else {
        result.push(list);
      }
      stack.push({ list, indent: paragraph.indent });
      top = stack[stack.length - 1]!;
    }

    // GFM has no syntax for an empty checklist item: `- [ ]` with nothing
    // after it parses as the literal text "[ ]", so remark-stringify won't
    // emit a checkbox for an item with no content. Convention: an empty
    // todo renders its checkbox as *raw* text (an html node dodges
    // escaping), and the parser recognizes the bare `- [ ]`/`- [x]` line
    // shape. A real bullet whose text is literally "[ ]" renders escaped
    // (`- \[ ]`), so the two can't collide.
    const emptyTodo = paragraph.kind === "todoList" && paragraph.text.length === 0;
    const item: ListItem = {
      type: "listItem",
      spread: false,
      ...(paragraph.kind === "todoList" && !emptyTodo ? { checked: paragraph.done ?? false } : {}),
      children: [
        {
          type: "paragraph",
          children: emptyTodo
            ? [{ type: "html", value: paragraph.done === true ? "[x]" : "[ ]" }]
            : phrasingFromParagraph(paragraph),
        },
      ],
    };
    top!.list.children.push(item);
  }
  return result;
}

// --- inline content ----------------------------------------------------------

interface StyledText {
  text: string;
  span: InlineSpan;
}

function phrasingFromParagraph(paragraph: FormatParagraph): PhrasingContent[] {
  const spans = normalizeSpans(paragraph);
  const pieces: StyledText[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.length > 0) {
      pieces.push({ text: paragraph.text.slice(at, at + span.length), span });
    }
    at += span.length;
  }
  return buildPhrasing(pieces, ["link", "bold", "italic", "strikethrough", "underline"]);
}

type InlineDimension = "link" | "bold" | "italic" | "strikethrough" | "underline";

function dimensionValue(span: InlineSpan, dimension: InlineDimension): string | boolean {
  switch (dimension) {
    case "link":
      return span.link;
    case "bold":
      return span.bold;
    case "italic":
      return span.italic;
    case "strikethrough":
      return span.strikethrough;
    case "underline":
      return span.underline;
  }
}

/**
 * Recursively wraps styled text pieces in inline constructs. At each level
 * the dimension with the *fewest* consecutive value-groups wraps first, so
 * a style spanning the whole range becomes the outermost wrapper - that
 * keeps delimiters from piling up back-to-back into ambiguous runs (a
 * whole-line italic containing a bold word must render `***word** rest*`,
 * never `***word****rest*`). Underline has no markdown notation and
 * becomes a raw `<u>`/`</u>` html pair around its group (fidelity mapping,
 * decided 2026-07-15).
 */
function buildPhrasing(pieces: readonly StyledText[], dimensions: readonly InlineDimension[]): PhrasingContent[] {
  let dimension: InlineDimension | undefined;
  let fewestGroups = Number.POSITIVE_INFINITY;
  for (const candidate of dimensions) {
    let groups = 0;
    let anyStyled = false;
    let previous: string | boolean | undefined;
    for (const piece of pieces) {
      const value = dimensionValue(piece.span, candidate);
      if (value !== previous) {
        groups += 1;
        previous = value;
      }
      if (value !== false && value !== "") {
        anyStyled = true;
      }
    }
    if (anyStyled && groups < fewestGroups) {
      dimension = candidate;
      fewestGroups = groups;
    }
  }
  if (dimension === undefined) {
    return pieces.map((piece): PhrasingContent => ({ type: "text", value: piece.text }));
  }
  const rest = dimensions.filter((candidate) => candidate !== dimension);
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < pieces.length) {
    const value = dimensionValue(pieces[i]!.span, dimension);
    let end = i;
    while (end < pieces.length && dimensionValue(pieces[end]!.span, dimension) === value) {
      end += 1;
    }
    const inner = buildPhrasing(pieces.slice(i, end), rest);
    if (value === false || value === "") {
      out.push(...inner);
    } else if (dimension === "link") {
      out.push({ type: "link", url: value as string, children: inner });
    } else if (dimension === "bold") {
      out.push({ type: "strong", children: inner });
    } else if (dimension === "italic") {
      out.push({ type: "emphasis", children: inner });
    } else if (dimension === "strikethrough") {
      out.push({ type: "delete", children: inner });
    } else {
      out.push({ type: "html", value: "<u>" }, ...inner, { type: "html", value: "</u>" });
    }
    i = end;
  }
  return out;
}
