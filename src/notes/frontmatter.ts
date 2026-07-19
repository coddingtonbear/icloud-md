/**
 * Local-only YAML frontmatter handling (Option A, dev log 2026-07-19).
 *
 * The note's title - and therefore its file name - is its first line, which
 * collides with the markdown convention that a leading `---` block is
 * frontmatter. Apple Notes has nowhere to store frontmatter, so this tool
 * treats it as a purely *local* annotation layer (Obsidian tags/aliases,
 * etc.): it is never pushed, and the note model (`deriveNoteTitle`, the
 * render->parse round-trip gate) only ever sees the body.
 *
 * This module is the file-I/O boundary that makes that true. `splitFrontmatter`
 * peels the envelope off a working file before its body reaches the parser,
 * merger, or base-copy comparison; `joinFrontmatter` puts it back when a
 * freshly rendered/merged body is written to disk.
 *
 * This is deliberately NOT markdown parsing (so it's outside the
 * no-hand-rolled-markdown ground rule of 2026-07-18): a frontmatter block is
 * a pre-markdown envelope whose boundary is defined at the *line* level. A
 * markdown library also wouldn't answer the one question that actually
 * matters here - whether a blank line between the closing `---` and the title
 * belongs to the envelope or to the body - so we own that decision explicitly
 * (it belongs to the envelope; see `splitFrontmatter`).
 */

const FENCE = "---";

export interface SplitMarkdown {
  /**
   * The leading frontmatter envelope: the `---` fences, the YAML between
   * them, and any blank lines that separate the block from the body - stored
   * verbatim (including its trailing newline) so re-writing preserves the
   * user's exact formatting. Empty string when the file has no frontmatter.
   * Invariant: `frontmatter + body` reproduces the original text exactly.
   */
  frontmatter: string;
  /**
   * The note body: everything after the envelope. Equal to the original text
   * when there is no frontmatter. This is what the parser, the 3-way merge,
   * and the base-copy comparison operate on - so a frontmatter-only edit
   * leaves the body untouched and never counts as a note change.
   */
  body: string;
}

/**
 * Splits a working file into its (local-only) frontmatter envelope and the
 * note body. Frontmatter is recognized only when the file's very first line
 * is exactly `---` and a later line is exactly `---`; anything else (a
 * thematic break, a `---` mid-document, an unterminated block) is left
 * wholly as body. Blank lines immediately after the closing fence are folded
 * into the envelope, so the common `---\n...\n---\n\n# Title` layout yields a
 * body of `# Title` - byte-identical to what the renderer produced and the
 * base copy stores.
 */
export function splitFrontmatter(text: string): SplitMarkdown {
  const lines = text.split("\n");
  if (lines[0] !== FENCE) {
    return { frontmatter: "", body: text };
  }

  let closingFence = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FENCE) {
      closingFence = i;
      break;
    }
  }
  // An opening `---` with no closing fence isn't frontmatter - a note body
  // legitimately can't start this way (a thematic break is unpublishable), so
  // treating it as body keeps such a file readable rather than eating it.
  if (closingFence === -1) {
    return { frontmatter: "", body: text };
  }

  // Fold trailing blank lines (the cosmetic separator) into the envelope.
  let envelopeEnd = closingFence;
  while (envelopeEnd + 1 < lines.length && lines[envelopeEnd + 1] === "") {
    envelopeEnd += 1;
  }

  const bodyLines = lines.slice(envelopeEnd + 1);
  const envelope = lines.slice(0, envelopeEnd + 1).join("\n");
  // The newline that terminates the last envelope line belongs to the
  // envelope, but only exists when there's a body line after it.
  const frontmatter = bodyLines.length > 0 ? envelope + "\n" : envelope;
  return { frontmatter, body: bodyLines.join("\n") };
}

/**
 * Re-attaches a frontmatter envelope (as produced by `splitFrontmatter`) above
 * a body. The envelope already carries its own trailing separator, so this is
 * a plain concatenation - the exact inverse of `splitFrontmatter`. `body` is
 * typically a freshly rendered or merged note body, while `frontmatter` was
 * captured from the file that is about to be overwritten.
 */
export function joinFrontmatter(frontmatter: string, body: string): string {
  return frontmatter + body;
}
