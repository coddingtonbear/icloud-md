/**
 * Shared wording/detection for content this tool couldn't parse.
 *
 * Two distinct surfaces, with different consequences:
 *
 *  - The whole-note **banner** (a markdown admonition prepended to the body):
 *    the note's embed structure itself defied this tool's model (see
 *    `decodeNoteEmbedSlots`), so nothing about it can be localized. A note
 *    carrying the banner is never pushable.
 *  - An inline **embed marker** (`<apple-embed …>label</apple-embed>`):
 *    one specific embedded object couldn't be rendered, but its position -
 *    and usually its identity - is precisely known. Marker-bearing notes ARE
 *    pushable: `push` requires every marker to survive verbatim in document
 *    order (each maps back to its U+FFFC placeholder), and refuses when one
 *    was deleted, edited, duplicated, or reordered. See `embedPushEdit.ts`.
 */

const ADMONITION_HEADER = "> [!danger] Unparsed content";

/** Prepended to a note's body when the embed structure couldn't be mapped at
 * all (an `attachmentInfo` run not sitting on a lone U+FFFC placeholder) -
 * see `decodeNoteEmbedSlots`. */
export const UNKNOWN_CONTENT_BANNER =
  `${ADMONITION_HEADER}\n` +
  "> This note contains content this tool can't parse or place precisely. " +
  "It stays read-only here until that's resolved (e.g. by editing the note in Notes directly).\n\n";

/** True if `text` still contains the whole-note banner - used by `push` to
 * refuse fast, before any network round trip. */
export function hasUnknownContentMarker(text: string): boolean {
  return text.includes(ADMONITION_HEADER);
}

/** What an inline embed marker carries. Both fields optional: an embed whose
 * `attachmentInfo` run was missing or incomplete still gets a marker, just
 * with less identity in it. */
export interface EmbedMarkerContent {
  typeUti?: string | undefined;
  attachmentIdentifier?: string | undefined;
}

/** Short human label shown as the marker's visible inner text (markdown
 * renderers display an unknown HTML element's inner text inline). Purely
 * cosmetic - identity lives in the attributes, and `push` compares the whole
 * marker string verbatim anyway. */
const EMBED_LABELS: Record<string, string> = {
  "com.apple.notes.gallery": "gallery",
  "com.apple.drawing.2": "drawing",
  "com.apple.drawing": "drawing",
  "com.apple.paper": "paper document",
  "com.apple.notes.table": "table",
  "public.url": "link preview",
};

const UNKNOWN_TYPE = "unknown";

/**
 * The inline marker written in place of one embed's U+FFFC placeholder when
 * the embed can't be rendered (unsupported kind, unresolvable record, or no
 * usable `attachmentInfo` at all). Replaces exactly the placeholder
 * character - no added newlines - so reversing it (marker -> U+FFFC)
 * reconstructs the remote text exactly.
 */
export function formatEmbedMarker(content: EmbedMarkerContent): string {
  const type = content.typeUti ?? UNKNOWN_TYPE;
  const label = EMBED_LABELS[type] ?? (content.typeUti === undefined ? "unidentified embed" : type);
  const idAttribute = content.attachmentIdentifier === undefined ? "" : ` id="${content.attachmentIdentifier}"`;
  return `<apple-embed type="${type}"${idAttribute}>${label}</apple-embed>`;
}

export interface ParsedEmbedMarker {
  /** Character range [start, end) of the whole marker in the searched text. */
  start: number;
  end: number;
  /** The exact matched text - `push` compares this verbatim against what
   * `formatEmbedMarker` would produce for the corresponding embed. */
  text: string;
  typeUti: string;
  attachmentIdentifier?: string | undefined;
}

const EMBED_MARKER_PATTERN = /<apple-embed\b([^>]*)>([^<]*)<\/apple-embed>/g;
const TYPE_ATTRIBUTE_PATTERN = /\btype="([^"]*)"/;
const ID_ATTRIBUTE_PATTERN = /\bid="([^"]*)"/;

/** Every embed-marker-shaped span in `text`, in document order. Liberal on
 * purpose: anything that looks like a marker is surfaced, and the caller
 * decides whether it exactly matches an expected one (a mangled marker must
 * show up here so `push` can refuse it, not silently pass it through as
 * literal text). */
export function parseEmbedMarkers(text: string): ParsedEmbedMarker[] {
  const markers: ParsedEmbedMarker[] = [];
  for (const match of text.matchAll(EMBED_MARKER_PATTERN)) {
    const attributes = match[1] ?? "";
    markers.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      typeUti: TYPE_ATTRIBUTE_PATTERN.exec(attributes)?.[1] ?? UNKNOWN_TYPE,
      attachmentIdentifier: ID_ATTRIBUTE_PATTERN.exec(attributes)?.[1],
    });
  }
  return markers;
}

/** True if `text` contains anything that even starts like an embed marker -
 * used by `push`'s create path (a brand-new note can't carry embeds). */
export function hasEmbedMarker(text: string): boolean {
  return /<apple-embed\b/.test(text);
}

/** Combines the two independent sources of "why is this note unpublishable"
 * into the single reason stored on a note's state entry. `undefined` if both
 * are absent. */
export function combineUnpublishableReasons(a: string | undefined, b: string | undefined): string | undefined {
  return [a, b].filter((reason): reason is string => reason !== undefined).join("; ") || undefined;
}
