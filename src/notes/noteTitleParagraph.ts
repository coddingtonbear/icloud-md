/**
 * Splitting a note's title paragraph off its body, and putting one back.
 *
 * Under `--filename-as-title` the note's title lives in the file *name*, and
 * the file holds only the body - so the first paragraph has to come off on
 * the way out and go back on the way in.
 *
 * ## Why this operates on paragraphs, not lines
 *
 * "Drop the first line" is the obvious implementation and it is wrong. A
 * note's title is its first line *by position only*; its paragraph style is
 * whatever the user set, and `STYLE_TO_KIND` allows `body`, `bulletList`,
 * `todoList` or `monospaced` there just as readily as `title`. When the first
 * paragraph is monospaced, the rendered first line is a ``` fence, and
 * dropping that line leaves an unbalanced code block that corrupts the whole
 * file. Splitting the *model* before `renderNoteMarkdown` sees it avoids the
 * entire class of problem.
 *
 * ## What is preserved, and until when
 *
 * `restoreTitleParagraph` puts back the note's original first paragraph -
 * style, inline formatting and all - so a heading-styled or bold title
 * survives every round trip untouched. Only when the user actually *renames
 * the file* does the title become plain text, because a filename can't carry
 * formatting and the rename is an explicit instruction to change the title.
 * That's the "don't lose formatting until the name changes" guarantee.
 *
 * Push reads the original paragraph from the live remote record rather than
 * from local state, matching the existing discipline that push re-derives
 * everything it can from a fresh fetch.
 */

import path from "node:path";
import { PLAIN_STYLE, type FormatParagraph } from "./noteFormat.js";
import { decodeTitleStem } from "./titleFilename.js";

export interface SplitTitleParagraph {
  /** The note's first paragraph - its title. Undefined only for a note with
   * no paragraphs at all, which shouldn't occur for a real note. */
  title: FormatParagraph | undefined;
  /**
   * Everything after it. Note that the blank paragraph Apple's editors
   * conventionally leave between a title and the body is *kept*: it's real
   * content, and dropping it would make every round trip lossy.
   */
  body: FormatParagraph[];
}

/** Splits a note's formatting model into its title paragraph and its body. */
export function splitTitleParagraph(paragraphs: readonly FormatParagraph[]): SplitTitleParagraph {
  const [title, ...body] = paragraphs;
  return { title, body };
}

/**
 * Rebuilds a full note model from a title paragraph and a body.
 *
 * `title` is the note's existing first paragraph when it still applies (the
 * filename hasn't changed), carrying its original style and inline runs.
 *
 * Recomputes every paragraph's `start`, which is not cosmetic: `start` is a
 * cumulative offset into the note's full text, and `formatReconcile` uses it
 * to address the exact character ranges it restyles. Prepending a paragraph
 * shifts every following offset, and leaving them stale would apply
 * formatting to the wrong text.
 */
export function restoreTitleParagraph(
  title: FormatParagraph,
  body: readonly FormatParagraph[],
): FormatParagraph[] {
  const paragraphs = [title, ...body].map((paragraph) => ({ ...paragraph }));
  let offset = 0;
  for (const paragraph of paragraphs) {
    paragraph.start = offset;
    offset += paragraph.text.length + 1;
  }
  return paragraphs;
}

/**
 * `restoreTitleParagraph` plus the plain text the rebuilt model projects to -
 * the pair every push site needs, since the text drives the CRDT splice and
 * the paragraphs drive the formatting reconciler, and the two must describe
 * the same note or the reconciler restyles the wrong characters.
 *
 * The join mirrors `parseNoteMarkdown`'s own `text`, which is what makes the
 * result indistinguishable from having parsed a file that still had its
 * title in it.
 */
export function restoreTitleParagraphText(
  title: FormatParagraph,
  body: readonly FormatParagraph[],
): { text: string; paragraphs: FormatParagraph[] } {
  const paragraphs = restoreTitleParagraph(title, body);
  return { text: paragraphs.map((paragraph) => paragraph.text).join("\n"), paragraphs };
}

/**
 * The title a note's file name carries in a filename-as-title vault.
 *
 * Note what this is *not* used for: deciding an unrenamed note's title.
 * A file name can be a lossy record of the title it was derived from - pull's
 * collision uniquifier appends " 2", and a future `apple-note-title` covers
 * the titles a name can't hold at all - so push only ever reads a title back
 * out of a name the user has just *changed*, where the name is the
 * instruction. Everywhere else the live remote paragraph is authoritative.
 */
export function titleFromNoteFileName(file: string): string {
  return decodeTitleStem(path.posix.basename(file, ".md"));
}

/**
 * The title paragraph for a note whose filename the user changed: plain text
 * in Apple's Title style, with no inline formatting.
 *
 * Style 0 ("title") rather than the paragraph's previous style, because a
 * renamed file is a new title and a filename carries no styling to preserve.
 * A note whose first line was body-styled therefore becomes title-styled on
 * rename - a small, deliberate drift, and the only alternative would be
 * guessing at formatting the user didn't express.
 */
export function titleParagraphFromFilename(title: string): FormatParagraph {
  return {
    kind: "title",
    indent: 0,
    blockQuoteLevel: 0,
    startNumber: 0,
    text: title,
    // One unstyled span covering the whole line: the previous paragraph's
    // spans described different text and can't be carried over.
    spans: title.length > 0 ? [{ length: title.length, ...PLAIN_STYLE }] : [],
    start: 0,
  };
}
