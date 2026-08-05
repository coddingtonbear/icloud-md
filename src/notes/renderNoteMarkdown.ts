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
 *
 * The one place this module overrides `remark-stringify`'s escaping is where
 * the escape would be *correct markdown but wrong for the reader*: bare URLs,
 * the punctuation GFM autolink literals make ambiguous (see
 * `findAutolinkEscapeRanges`), the Obsidian notation a vault is full of
 * (see `findObsidianRawRanges`), and a `---` body line, which is written as
 * a real thematic break rather than `\---` (see `rendersAsThematicBreak` -
 * the one of the four that is a *block* rather than an escaped range; the
 * others are emitted as raw `html` nodes). Whichever rules apply, the result
 * is re-parsed here before it is kept - `renderNoteMarkdown` falls back to
 * plain `remark-stringify` escaping for the whole note otherwise, so the
 * friendlier spelling can never cost fidelity.
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
  ThematicBreak,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import {
  formatsRoundTripEqual,
  inlineStylesEqual,
  normalizeSpans,
  PLAIN_STYLE,
  trimTrailingWhitespace,
  type FormatParagraph,
  type InlineSpan,
  type ParagraphKind,
} from "./noteFormat.js";
import { parseNoteMarkdown, THEMATIC_BREAK_TEXT } from "./parseNoteMarkdown.js";

/** Same plugin set as the parser and `markdownTable.ts`, so escaping
 * decisions and construct recognition always agree. */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm, { tablePipeAlign: false })
  // `rule: "-"` only affects thematic breaks, and `---` is the one spelling
  // the parser accepts back (`THEMATIC_BREAK_TEXT`).
  .use(remarkStringify, { bullet: "-", rule: "-" });

const HEADING_DEPTHS: Partial<Record<ParagraphKind, 1 | 2 | 3>> = {
  title: 1,
  heading: 2,
  subheading: 3,
};

/**
 * Which of the friendlier-but-optional unescaping rules a render pass may
 * use. Bare URLs (`findRawUrlRanges`) are not in here: they are unconditional,
 * because they are what this renderer emitted before any of this existed.
 */
export interface RawSpelling {
  /** Obsidian's own notation - see `findObsidianRawRanges`. */
  obsidian: boolean;
  /** Punctuation escaped only against GFM autolink literals - see
   * `findAutolinkEscapeRanges`. */
  autolink: boolean;
  /** A `---` body line written as a real thematic break rather than
   * `\---` - see `rendersAsThematicBreak`. */
  thematicBreak: boolean;
}

/** No optional rule at all: the escaping `remark-stringify` chose on its
 * own, and the fallback every caller ends at. */
export const CONSERVATIVE_SPELLING: RawSpelling = { obsidian: false, autolink: false, thematicBreak: false };

/**
 * The spellings worth *trying* for these lines, nicest first: only the rules
 * that would actually change something, and each combination of them, so a
 * line that defeats one rule doesn't cost the reader the other. The
 * conservative spelling is the caller's fallback and is not listed.
 */
export function spellingCandidates(lines: Iterable<string>): RawSpelling[] {
  let obsidian = false;
  let autolink = false;
  let thematicBreak = false;
  for (const line of lines) {
    obsidian ||= findObsidianRawRanges(line).length > 0;
    autolink ||= findAutolinkEscapeRanges(line).length > 0;
    thematicBreak ||= line === THEMATIC_BREAK_TEXT;
  }
  const candidates: RawSpelling[] = [
    { obsidian: true, autolink: true, thematicBreak: true },
    { obsidian: true, autolink: true, thematicBreak: false },
    { obsidian: true, autolink: false, thematicBreak: true },
    { obsidian: false, autolink: true, thematicBreak: true },
    { obsidian: true, autolink: false, thematicBreak: false },
    { obsidian: false, autolink: true, thematicBreak: false },
    { obsidian: false, autolink: false, thematicBreak: true },
  ];
  return candidates.filter(
    (candidate) =>
      (!candidate.obsidian || obsidian) && (!candidate.autolink || autolink) && (!candidate.thematicBreak || thematicBreak),
  );
}

/**
 * Renders the note, preferring the friendliest spelling (see
 * `spellingCandidates`) that is *provably* the same document.
 *
 * The unescaping rules below are read off CommonMark's own construct
 * definitions, but reading a spec is not the same as being right, and the
 * cost of being wrong would be a note that stops round-tripping - which
 * `classifyNoteRecord` turns into a read-only note. So the preference is
 * checked rather than trusted: render it, parse it back, and keep it only if
 * the projection survives exactly. Anything else falls back to the next
 * spelling down, and ultimately to the escaping `remark-stringify` chose on
 * its own, which is what this renderer emitted before any friendlier spelling
 * was considered at all.
 *
 * That makes the whole feature a strict improvement by construction: a
 * friendlier spelling can never be *worse* than the conservative one, only
 * equal or nicer to read. (When even the conservative rendering fails to
 * round-trip, the note is refused upstream and this output is discarded, so
 * the fallback costs nothing there either.)
 */
export function renderNoteMarkdown(rawParagraphs: readonly FormatParagraph[]): string {
  // Trailing whitespace is outside the projection (`trimTrailingWhitespace`);
  // rendering it would need `&#x20;` references to survive reparsing.
  const paragraphs = rawParagraphs.map(trimTrailingWhitespace);
  for (const spelling of spellingCandidates(paragraphs.map((paragraph) => paragraph.text))) {
    const rendered = renderLines(paragraphs, spelling);
    if (projectionSurvives(paragraphs, rendered)) {
      return rendered;
    }
  }
  return renderLines(paragraphs, CONSERVATIVE_SPELLING);
}

/** Whether re-parsing `rendered` reproduces `paragraphs` exactly - the same
 * check `classifyNoteRecord` gates publishability on, applied here to decide
 * between two spellings of the same note rather than to accept or refuse it. */
function projectionSurvives(paragraphs: readonly FormatParagraph[], rendered: string): boolean {
  const back = parseNoteMarkdown(rendered);
  return (
    back.status === "ok" &&
    back.text === paragraphs.map((paragraph) => paragraph.text).join("\n") &&
    formatsRoundTripEqual(paragraphs, back.paragraphs)
  );
}

function renderLines(paragraphs: readonly FormatParagraph[], spelling: RawSpelling): string {
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
      for (const list of buildListNodes(paragraphs.slice(i, end), spelling)) {
        pushBlockLines(lines, list, bq);
      }
      i = end;
      continue;
    }

    const depth = HEADING_DEPTHS[paragraph.kind];
    if (depth !== undefined) {
      const heading: Heading = { type: "heading", depth, children: phrasingFromParagraph(paragraph, spelling) };
      pushBlockLines(lines, heading, bq);
      i += 1;
      continue;
    }

    if (spelling.thematicBreak && rendersAsThematicBreak(paragraphs, i)) {
      const rule: ThematicBreak = { type: "thematicBreak" };
      pushBlockLines(lines, rule, bq);
      i += 1;
      continue;
    }

    // Body. An empty body line is written literally (a blank line, or bare
    // `>` markers at blockquote level) rather than stringified - remark has
    // no notion of an empty paragraph.
    if (paragraph.text.length === 0) {
      lines.push(bq === 0 ? "" : ">".repeat(bq));
    } else {
      const body: Paragraph = { type: "paragraph", children: phrasingFromParagraph(paragraph, spelling) };
      pushBlockLines(lines, body, bq);
    }
    i += 1;
  }
  return lines.join("\n");
}

/**
 * Whether the paragraph at `index` may be written as a real `---` rule
 * instead of the `\---` `remark-stringify` escapes it to. Apple has no rule
 * construct, so the note stores three literal dashes and the parser reads
 * them back as one (`recordThematicBreak`) - what this decides is only how
 * the *file* spells them.
 *
 * Two positions are excluded, both because a bare `---` there would mean
 * something else entirely on reparse:
 *
 * - **Directly below a non-empty body line**, where `---` is a setext
 *   underline and the pair becomes a Heading (`> a` / `> ---` too - the
 *   quote markers don't change that). Everything else above it - a blank
 *   line, an ATX heading, a list item, a fenced block, another rule - leaves
 *   a genuine thematic break, as CommonMark and this repo's own remark
 *   pipeline both confirm.
 * - **As the body's very first line**, where `splitFrontmatter` would read
 *   it as a frontmatter opening fence. That only bites in a filename-as-
 *   title vault (elsewhere the body opens with the note's title line), and
 *   there it would eat everything up to the next `---` as an envelope. The
 *   renderer simply never writes that file.
 *
 * Styled dashes (a bold `---`, say) are excluded too: a rule has nowhere to
 * put the styling, and dropping it would fail the round-trip check below and
 * cost the note its other friendly spellings as well.
 *
 * Consecutive rules stand or fall together: `---` under `---` is a second
 * thematic break, but under an escaped `\---` - an ordinary paragraph - it
 * is that paragraph's setext underline. So the run is traced back to the
 * paragraph above it, and that one line decides for all of them.
 */
function rendersAsThematicBreak(paragraphs: readonly FormatParagraph[], index: number): boolean {
  if (!isPlainRuleParagraph(paragraphs[index])) {
    return false;
  }
  let start = index;
  while (start > 0 && isPlainRuleParagraph(paragraphs[start - 1])) {
    start -= 1;
  }
  const previous = paragraphs[start - 1];
  if (previous === undefined) {
    return false;
  }
  return !(previous.kind === "body" && previous.text.length > 0);
}

/** A Body paragraph holding nothing but three unstyled dashes - the model's
 * side of a thematic break. */
function isPlainRuleParagraph(paragraph: FormatParagraph | undefined): boolean {
  return (
    paragraph !== undefined &&
    paragraph.kind === "body" &&
    paragraph.text === THEMATIC_BREAK_TEXT &&
    normalizeSpans(paragraph).every((span) => inlineStylesEqual(span, PLAIN_STYLE))
  );
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
function buildListNodes(paragraphs: readonly FormatParagraph[], spelling: RawSpelling): List[] {
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
            : phrasingFromParagraph(paragraph, spelling),
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
  /** UTF-16 offset of this piece within its paragraph's text. */
  start: number;
}

/**
 * Bare URLs in the note's plain text would be escaped by remark-stringify
 * (`https\://...` - it must keep reparsing from manufacturing a GFM autolink
 * literal), which reads as mangling in the local file. URL tokens made only
 * of characters that can't open an inline construct or decode as a character
 * reference are safe to emit as raw `html` nodes instead (the same
 * escape-dodging device as `<u>` and the empty-todo checkbox): reparsing
 * turns them into autolink literals, which the parser collapses back to
 * plain text (`normalizeSpans`), so the round-trip gate stays green either
 * way. Anything outside that character set - `*` `_` `~` `` ` `` brackets,
 * backslashes, entity-shaped `&...;` runs - falls back to escaped text.
 *
 * Boundaries are checked against the *whole line*, not the styled piece:
 * a raw token must be preceded by start/whitespace/`(` and followed by
 * whitespace or end of line, because an autolink literal swallows any
 * following non-whitespace on reparse - including a backslash escape the
 * adjacent text node needed (`https://x` + `\_B` would reparse with a
 * literal backslash inside the URL).
 */
/** The characters a raw token may be made of: none of them can open an
 * inline construct, and (with `ENTITY_SHAPED` below) none can decode as a
 * character reference. */
const RAW_TOKEN_CLASS = "[A-Za-z0-9./?=&%#+:,;@!$'()-]";
const RAW_URL_PATTERN = new RegExp(`https?:\\/\\/${RAW_TOKEN_CLASS}+`, "g");
const ENTITY_SHAPED = /&(?:#|[A-Za-z][A-Za-z0-9]*;)/;

interface RawRange {
  start: number;
  end: number;
}

/** The shared safety test for emitting `text.slice(start, end)` raw. */
function rawRangesFor(text: string, pattern: RegExp): RawRange[] {
  const out: RawRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length;
    const before = match.index === 0 ? "" : text[match.index - 1]!;
    const after = end >= text.length ? "" : text[end]!;
    if (before !== "" && before !== "(" && !/\s/.test(before)) {
      continue;
    }
    if (after !== "" && !/\s/.test(after)) {
      continue;
    }
    if (ENTITY_SHAPED.test(match[0])) {
      continue;
    }
    out.push({ start: match.index, end });
  }
  return out;
}

function findRawUrlRanges(text: string): RawRange[] {
  return rawRangesFor(text, RAW_URL_PATTERN);
}

/**
 * The *rest* of what GFM autolink literals cost the reader. `remark-stringify`
 * escapes by position rather than by outcome here too, and the positions come
 * from `mdast-util-gfm-autolink-literal`'s `unsafe` list, whose `before`
 * guards are a single character wide: a `.` is escaped after any `w` or `W`
 * (not just after a real `www`), and an `@` between word characters. So
 * ordinary prose picks up backslashes that have nothing to do with links -
 * `flow\.ts`, `window\.open()`, `new\.txt`, `me\@example.com` - and so does
 * the case that prompted this rule, `Www\.VJW\.digital.go.jp`, where only two
 * of the four dots are even ambiguous.
 *
 * The fix is the same device the bare-URL rule uses: emit the whole token raw
 * as an `html` node. A token here is a run of `RAW_TOKEN_CLASS` characters
 * containing at least one of those escape triggers, under the same boundary
 * and entity checks - so on reparse it is either plain text again (nothing in
 * the character set can open a construct) or a GFM autolink literal, which
 * the parser does not treat as a link span and collapses straight back to
 * plain text. Either way the text is unchanged, and `renderNoteMarkdown`
 * checks that rather than trusting it.
 *
 * Anything with an `_` (or any other emphasis-active character) adjacent to
 * the trigger falls outside the character set and stays escaped, as it must.
 */
const AUTOLINK_ESCAPE_PATTERN = new RegExp(
  `${RAW_TOKEN_CLASS}*(?:[Ww]\\.[A-Za-z0-9.-]|[A-Za-z0-9.+-]@[A-Za-z0-9.-]|[ps]:\\/)${RAW_TOKEN_CLASS}*`,
  "g",
);

function findAutolinkEscapeRanges(text: string): RawRange[] {
  return rawRangesFor(text, AUTOLINK_ESCAPE_PATTERN);
}

/**
 * Obsidian's own notation - wikilinks and embeds (`[[Note]]`,
 * `[[Note|alias]]`, `![[img.png|300]]`), callouts (`> [!NOTE] Title`),
 * footnote references (`[^1]`, `^[inline]`), and tags (`#project`) - is not
 * markdown at all. To Apple it is ordinary text, and to CommonMark it is
 * ordinary text too. `remark-stringify` escapes it anyway, because it escapes
 * by *position* rather than by outcome: any `[` might pair with a later `](`,
 * and any line-leading `#` might be a heading. The note still round-trips,
 * but the reader's vault loses a link, a callout, or a tag, and the file
 * picks up a gratuitous diff.
 *
 * Emitting these runs verbatim - as raw `html` nodes, the same escape-dodging
 * device the bare-URL rule uses (and `<u>`, and the empty-todo checkbox) -
 * gives the file back its Obsidian spelling, and reparsing turns each run
 * straight back into the same plain text.
 *
 * Each rule below is drawn from what CommonMark actually requires, and each
 * one leaves the genuinely ambiguous cases escaped:
 *
 * - **Bracket runs.** A `[...]` or `[[...]]` run (optionally preceded by `!`)
 *   is inert unless something *after* it makes it a link: `(` opens an inline
 *   link (`[a](b)`), `[` a reference link (`[a][b]`), and `:` a link
 *   definition (`[a]: url`) - all three disqualify the run. So does any
 *   character inside it that could open an inline construct, decode as a
 *   character reference, or eat the next character (`[` `]` `\` `<` `>` `&`
 *   `*` `_` `~` `` ` ``).
 * - **Line-leading `#` runs.** An ATX heading needs a space, a tab, or the
 *   end of the line after its `#`s, so `#project` is a tag and `# Heading` is
 *   a heading. Only the former is unescaped.
 * - **Line-leading `=` runs.** A setext heading underline is a line of
 *   *nothing but* `=`, so `==highlight==` is safe and a bare `===` is not.
 *
 * None of this is trusted on its own: `renderNoteMarkdown` reparses the
 * result and falls back to full escaping unless the note comes back
 * identical.
 */
const RAW_BRACKET_PATTERN = /!?(?:\[\[[^[\]\n\\<>&*_~`]*\]\]|\[[^[\]\n\\<>&*_~`]*\])/g;
const BRACKET_LINK_OPENERS = new Set(["(", "[", ":"]);
const LEADING_TAG_PATTERN = /^#+(?![ \t]|$)/;
const LEADING_EQUALS_PATTERN = /^=+/;

function findObsidianRawRanges(text: string): RawRange[] {
  const out: RawRange[] = [];
  const leading = LEADING_TAG_PATTERN.exec(text) ?? (/^=+$/.test(text) ? null : LEADING_EQUALS_PATTERN.exec(text));
  if (leading) {
    out.push({ start: 0, end: leading[0].length });
  }
  for (const match of text.matchAll(RAW_BRACKET_PATTERN)) {
    const end = match.index + match[0].length;
    if (BRACKET_LINK_OPENERS.has(text[end] ?? "")) {
      continue;
    }
    out.push({ start: match.index, end });
  }
  return out;
}

/** Every range in the line that may be written raw, in source order and
 * non-overlapping (a URL inside a wikilink target, say, is already covered by
 * the wikilink's own run; an overlap is resolved in favor of the earlier
 * range, and a tie in favor of the longer one - a line-leading `#new.stuff`
 * tag is one raw run, not a raw `#` followed by an escaped `new\.stuff`).
 * `spelling` selects between the
 * spellings `renderNoteMarkdown` picks from; bare URLs are in all of them,
 * because they are what this renderer emitted before the optional rules
 * existed. */
function findRawRanges(text: string, spelling: RawSpelling): RawRange[] {
  const all = [
    ...findRawUrlRanges(text),
    ...(spelling.obsidian ? findObsidianRawRanges(text) : []),
    ...(spelling.autolink ? findAutolinkEscapeRanges(text) : []),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: RawRange[] = [];
  for (const range of all) {
    const previous = out[out.length - 1];
    if (previous === undefined || range.start >= previous.end) {
      out.push(range);
    }
  }
  return out;
}

/** Splits one piece of plain text (starting at `absoluteStart` within its
 * line) into text nodes and raw-html nodes, honoring only the ranges that
 * fall entirely inside this piece - a range split across a style boundary
 * renders escaped instead. In a table cell (`escapePipes`) a `|` can't ride
 * along in a raw node - it would end the cell - so the run is broken around
 * its pipes and they render as text, which `remark-stringify` escapes to
 * `\|`: exactly the form Obsidian itself requires for a piped wikilink
 * inside a table. */
function textPieces(
  value: string,
  absoluteStart: number,
  rawRanges: readonly RawRange[],
  escapePipes = false,
): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let at = 0;
  for (const range of rawRanges) {
    const start = range.start - absoluteStart;
    const end = range.end - absoluteStart;
    if (start < at || end > value.length) {
      continue;
    }
    if (start > at) {
      out.push({ type: "text", value: value.slice(at, start) });
    }
    const raw = value.slice(start, end);
    if (escapePipes && raw.includes("|")) {
      raw.split("|").forEach((part, index) => {
        if (index > 0) {
          out.push({ type: "text", value: "|" });
        }
        if (part.length > 0) {
          out.push({ type: "html", value: part });
        }
      });
    } else {
      out.push({ type: "html", value: raw });
    }
    at = end;
  }
  if (at === 0) {
    return [{ type: "text", value }];
  }
  if (at < value.length) {
    out.push({ type: "text", value: value.slice(at) });
  }
  return out;
}

/** URL-, autolink- and Obsidian-aware plain-text phrasing for single-line
 * contexts where end-of-string is a safe boundary (table cells: what follows
 * is `<br>`, `|` notation, or nothing - none of which an autolink literal can
 * swallow). `renderMarkdownTable` owns the same choice among spellings this
 * module's `renderNoteMarkdown` makes, which is why `spelling` is its
 * caller's to pass. */
export function textPhrasing(value: string, spelling: RawSpelling): PhrasingContent[] {
  return textPieces(value, 0, findRawRanges(value, spelling), true);
}

function phrasingFromParagraph(paragraph: FormatParagraph, spelling: RawSpelling): PhrasingContent[] {
  const spans = normalizeSpans(paragraph);
  const pieces: StyledText[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.length > 0) {
      pieces.push({ text: paragraph.text.slice(at, at + span.length), span, start: at });
    }
    at += span.length;
  }
  return buildPhrasing(
    pieces,
    ["link", "bold", "italic", "strikethrough", "underline"],
    findRawRanges(paragraph.text, spelling),
  );
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
function buildPhrasing(
  pieces: readonly StyledText[],
  dimensions: readonly InlineDimension[],
  rawRanges: readonly RawRange[],
): PhrasingContent[] {
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
    return pieces.flatMap((piece) => textPieces(piece.text, piece.start, rawRanges));
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
    const inner = buildPhrasing(pieces.slice(i, end), rest, rawRanges);
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
