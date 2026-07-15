/**
 * Shared wording/detection for content this tool couldn't parse - written
 * inline (as a markdown admonition) instead of refusing the whole note, per
 * the Safety Guarantee Audit. A note carrying either of these is never
 * pushable; see `classifyNoteRecord`'s `publishable` flag and `push.ts`.
 */

const ADMONITION_HEADER = "> [!danger] Unparsed content";

/** Prepended to a note's body when we can't reliably tell *which* placeholder
 * is the unrecognized one (a raw placeholder/attachment-count mismatch) -
 * see `classifyNoteRecord`. */
export const UNKNOWN_CONTENT_BANNER =
  `${ADMONITION_HEADER}\n` +
  "> This note contains content this tool can't parse or place precisely. " +
  "It stays read-only here until that's resolved (e.g. by editing the note in Notes directly).\n\n";

/** A block-level admonition dropped in place of one specific unresolvable
 * embed's placeholder (a table/attachment reference whose position IS known,
 * unlike the whole-note banner above). Assumes the embed occupied its own
 * paragraph in the original note, same assumption `formatAttachmentMarkdown`
 * already makes for successfully-resolved embeds. */
export function formatUnknownEmbedMarker(typeUti: string): string {
  return `${ADMONITION_HEADER}\n> This tool couldn't parse the embedded \`${typeUti}\` content that was here. This note stays read-only until that's resolved.\n\n`;
}

/** True if `text` still contains a banner or embed marker this tool wrote -
 * used by `push` to refuse fast, before any network round trip. */
export function hasUnknownContentMarker(text: string): boolean {
  return text.includes(ADMONITION_HEADER);
}

/** Combines the two independent sources of "why is this note unpublishable"
 * (`classifyNoteRecord`'s whole-note check, `resolveNoteAttachments`'s
 * per-reference check) into the single reason stored on a note's state
 * entry. `undefined` if both are absent. */
export function combineUnpublishableReasons(a: string | undefined, b: string | undefined): string | undefined {
  return [a, b].filter((reason): reason is string => reason !== undefined).join("; ") || undefined;
}
