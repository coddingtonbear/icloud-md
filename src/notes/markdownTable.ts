/**
 * The markdown side of the table pipeline: rendering a decoded table grid as
 * a GFM pipe table, parsing one back, and locating table-shaped blocks
 * inside a note's full text (a table's rendered markdown is spliced directly
 * into the body text at read time - see `resolveNoteAttachments` - with no
 * other marker separating it from surrounding prose).
 *
 * All parsing and serialization goes through unified/remark (project ground
 * rule, 2026-07-16: no hand-rolled markdown scanning anywhere - see the
 * "Table write engine (1/4)" investigation). The few places below that look
 * at raw lines are structural *guards* on top of what remark already parsed,
 * not parsers: GFM is laxer than the shape this project's own renderer
 * emits (rows may omit their leading/trailing pipes, and a paragraph line
 * directly after a table is lazily absorbed into it as a one-cell row), and
 * `push`'s safety model depends on *not* honoring that laxness - a block
 * that stops matching the strict shape must end there, so the block count
 * cross-check against the note's actual attachments can catch it.
 *
 * Output-format note: `remark-stringify` cannot be configured to reproduce
 * the previous hand-rolled renderer's exact bytes (it emits `| - |`
 * separator rows rather than `| --- |`, pads empty cells with one space
 * rather than two, and backslash-escapes markdown punctuation inside cell
 * text). Every variant parses back to the identical grid, and local-edit
 * detection compares file bytes against the base copy (both written by the
 * same renderer generation) rather than re-rendering, so on-disk files only
 * pick up the new format when a remote change rewrites them anyway - see
 * the dev log entry for this change.
 */

import type { PhrasingContent, Root, Table, TableCell, TableRow } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

/** `tablePipeAlign: false` is the closest available match to the previous
 * renderer's format: no column-width alignment padding. */
const processor = unified().use(remarkParse).use(remarkGfm, { tablePipeAlign: false }).use(remarkStringify);

export interface MarkdownTableBlock {
  /** Line index (0-based) of the block's header row. */
  startLine: number;
  /** Line index one past the block's last row. */
  endLine: number;
  grid: string[][];
}

// --- rendering -------------------------------------------------------------

export function renderMarkdownTable(grid: readonly string[][]): string {
  const header = grid[0];
  if (!header) {
    throw new Error("Table has no rows - refusing to guess at its structure");
  }
  const table: Table = {
    type: "table",
    children: grid.map(
      (row): TableRow => ({
        type: "tableRow",
        children: row.map((cell): TableCell => ({ type: "tableCell", children: cellChildren(cell) })),
      }),
    ),
  };
  const root: Root = { type: "root", children: [table] };
  return processor.stringify(root).replace(/\n$/, "");
}

/** Cell text is plain text plus embedded newlines (`noteText` is the literal
 * cell content); newlines can't survive inside a single-line GFM table row,
 * so they're carried as raw `<br>` html nodes, same notation the previous
 * renderer used. Everything else is a text node - `remark-stringify` owns
 * the escaping. */
function cellChildren(text: string): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  text.split(/\r?\n/).forEach((part, index) => {
    if (index > 0) {
      children.push({ type: "html", value: "<br>" });
    }
    if (part.length > 0) {
      children.push({ type: "text", value: part });
    }
  });
  return children;
}

// --- parsing ----------------------------------------------------------------

/**
 * Parses a single GFM pipe table back into a grid, for `push` to diff the
 * locally-edited markdown against the table's current state. Deliberately
 * narrow: the input must be exactly one strictly-shaped table (every row
 * pipe-delimited, every row matching the header's column count) with nothing
 * but blank lines around it - anything else throws, which `push` treats as
 * "can't safely apply this edit" rather than guessing.
 */
export function parseMarkdownTable(markdown: string): string[][] {
  const blocks = findMarkdownTableBlocks(markdown);
  const [block] = blocks;
  if (!block || blocks.length > 1) {
    throw new Error("Markdown table is missing its header or separator row, or contains more than one table");
  }
  const lines = markdown.split("\n");
  lines.forEach((line, index) => {
    if ((index < block.startLine || index >= block.endLine) && line.trim() !== "") {
      throw new Error(
        "Markdown table has a row with a different column count than its header, or trailing content - refusing to guess",
      );
    }
  });
  return block.grid;
}

/**
 * Scans `text` for strictly-shaped GFM pipe-table blocks (the same shape
 * `renderMarkdownTable` produces), in document order. Only root-level tables
 * count - a table nested in a blockquote or list can't be one this project
 * spliced in, and splicing whole lines back out of one would corrupt its
 * container. A block that starts like a table but hits a row with the wrong
 * column count, or a line remark only absorbed via GFM's lax row syntax
 * (no leading/trailing pipes - including prose directly below a table, which
 * GFM lazily swallows as a one-cell row), ends at the last strict row -
 * `push` is expected to cross-check the resulting block count against how
 * many table attachments the note actually has and refuse if they don't
 * match, rather than trust a possibly-spurious match.
 */
export function findMarkdownTableBlocks(text: string): MarkdownTableBlock[] {
  const lines = text.split("\n");
  const blocks: MarkdownTableBlock[] = [];
  let fromLine = 0;
  // Re-parse the remainder after each block: truncating a block means remark
  // may have swallowed genuinely separate content (even a whole second
  // table) into the same table node, so positions past the cut can't be
  // trusted from the same parse.
  while (fromLine < lines.length) {
    const remainder = lines.slice(fromLine).join("\n");
    const table = firstRootTable(processor.parse(remainder));
    if (!table) {
      break;
    }
    const startLine = nodeStartLine(table);
    const headerRow = table.children[0];
    if (!headerRow) {
      throw new Error("Markdown table node has no header row");
    }
    const headerLine = lines[fromLine + startLine];
    const separatorLine = lines[fromLine + startLine + 1];
    if (headerLine === undefined || separatorLine === undefined || !isStrictPipeLine(headerLine) || !isStrictPipeLine(separatorLine)) {
      // A table remark accepted but this project's strict shape doesn't
      // (e.g. a header row without its leading pipe): skip the header line
      // and rescan, matching how the previous line scanner moved on.
      fromLine += startLine + 1;
      continue;
    }

    const header = headerRow.children.map((cell) => cellText(cell, remainder));
    const grid = [header];
    let endLine = startLine + 2;
    for (const row of table.children.slice(1)) {
      const rowLine = lines[fromLine + nodeStartLine(row)];
      if (row.children.length !== header.length || rowLine === undefined || !isStrictPipeLine(rowLine)) {
        break;
      }
      grid.push(row.children.map((cell) => cellText(cell, remainder)));
      endLine = nodeStartLine(row) + 1;
    }

    blocks.push({ startLine: fromLine + startLine, endLine: fromLine + endLine, grid });
    fromLine += endLine;
  }
  return blocks;
}

function firstRootTable(root: Root): Table | undefined {
  return root.children.find((node): node is Table => node.type === "table");
}

/** 0-based line index of a node's first line, relative to the parsed text. */
function nodeStartLine(node: Table | TableRow): number {
  const line = node.position?.start.line;
  if (line === undefined) {
    throw new Error("Markdown table node is missing its source position");
  }
  return line - 1;
}

/** The strict row shape this project's own renderer emits - GFM itself also
 * accepts rows without leading/trailing pipes, which `findMarkdownTableBlocks`
 * deliberately does not honor (see its doc comment). */
function isStrictPipeLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith("|") && trimmed.endsWith("|");
}

const BR_TAG = /^<br\s*\/?>$/i;

/**
 * A cell's literal text: text nodes contribute their (already-unescaped)
 * values, `<br>` html nodes are the newline notation `renderMarkdownTable`
 * emits, and any other construct (emphasis, inline code, links... -
 * possible in hand-edited files, or files written before cell text was
 * escaped on render) contributes its raw source slice, so that e.g. a cell
 * whose stored text is literally `*bold*` still round-trips as `*bold*`
 * rather than collapsing to `bold`. The one position-less case: GFM's
 * autolink-literal transform splits text nodes around bare URLs *after*
 * parsing (backslash escapes don't suppress it), producing `link`/`text`
 * nodes with no source position - an autolink literal's text content is
 * exactly its source text, so plain string extraction is the correct
 * fallback there.
 */
function cellText(cell: TableCell, source: string): string {
  let text = "";
  for (const child of cell.children) {
    if (child.type === "text") {
      text += child.value;
      continue;
    }
    if (child.type === "html" && BR_TAG.test(child.value)) {
      text += "\n";
      continue;
    }
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    text += start === undefined || end === undefined ? mdastToString(child) : source.slice(start, end);
  }
  return text;
}
