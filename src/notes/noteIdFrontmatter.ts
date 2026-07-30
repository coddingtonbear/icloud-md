/**
 * Reads and writes the `apple-note-id` key inside a note's local-only
 * frontmatter envelope (see `frontmatter.ts` for what that envelope is and
 * why it never reaches iCloud).
 *
 * ## Why the id lives in the file
 *
 * Tracking a note by its *path* means a rename is indistinguishable from a
 * delete plus an unrelated create, which only heuristics can pair back up.
 * Carrying the note's identity in the file makes renames, moves, and
 * rename-plus-edit-in-one-go all resolve exactly. Path tracking stays, but
 * as an index and as the handle for files that no longer exist - not as
 * identity (see the 2026-07-30 dev log).
 *
 * The value is the note's CloudKit `recordName`: a UUID that is genuinely
 * Apple's identifier for that note across every Apple client, which is why
 * the key is `apple-note-id` rather than something tool-specific. Two
 * caveats worth knowing:
 *
 *  - Notes this tool *creates* get a client-generated recordName, so it's an
 *    id in Apple's namespace that Apple accepted, not one Apple issued.
 *  - recordNames are unique within a CloudKit *zone*, not globally. A shared
 *    note lives in the sharer's zone. `state.notes` already keys by bare
 *    recordName across all zones, so this inherits an assumption the vault
 *    already makes - but it must not be documented as globally unique.
 *
 * ## Why a real YAML parser
 *
 * We are not the only writer of this block: Obsidian, Templater, Dataview
 * and linter plugins all touch it, and YAML has several ways to spell the
 * same string (plain, single-quoted, double-quoted, literal `|`, folded
 * `>`). A line-level scan also can't tell a top-level key from one nested
 * under `aliases:` or one sitting inside a block scalar's text. So this
 * module uses `yaml`'s document API - specifically the one that preserves
 * comments, key order, and quoting style, since reformatting a user's
 * frontmatter every time we stamp an id would be its own kind of damage.
 *
 * `frontmatter.ts` promises the envelope round-trips byte-for-byte, and
 * re-serializing through YAML can't guarantee that in every edge case. The
 * reconciliation is that this module only ever *writes* when something
 * actually needs to change: `setNoteId` returns the envelope untouched when
 * the id is already correct, which is the overwhelmingly common path.
 */

import { isMap, parseDocument, type Document } from "yaml";
import { joinFrontmatter } from "./frontmatter.js";

/** The frontmatter key carrying a note's CloudKit recordName. */
export const NOTE_ID_KEY = "apple-note-id";

/**
 * The frontmatter key carrying a note's real title, for the rare note whose
 * title a file name genuinely can't hold (`titleIsRepresentable` decides;
 * homoglyph substitution keeps the list short). Such a note is filed as
 * `Untitled.md` and this key is the only record of what it's actually
 * called.
 *
 * Deliberately absent for every other note. Duplicating a representable
 * title into frontmatter would create a second source of truth for it, and
 * then a disagreement between the two would have no correct resolution.
 */
export const NOTE_TITLE_KEY = "apple-note-title";

/** Shape a recordName must have to be trusted as an id: a UUID, in either
 * case (Apple's own clients write uppercase, other writers lowercase). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isNoteId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The note id recorded in a frontmatter envelope, or undefined when there
 * isn't a usable one.
 *
 * Deliberately total: unparseable YAML, a missing key, a non-scalar value,
 * and a value that isn't UUID-shaped all read as "no id" rather than an
 * error. A file with a broken frontmatter block is a file someone is
 * part-way through editing, and it must degrade to path matching rather
 * than fail a whole push.
 */
export function readNoteId(frontmatter: string): string | undefined {
  const doc = parseFrontmatterDocument(frontmatter);
  if (!doc) {
    return undefined;
  }
  const value: unknown = doc.get(NOTE_ID_KEY);
  if (typeof value !== "string" || !isNoteId(value)) {
    return undefined;
  }
  return value;
}

/**
 * Returns `frontmatter` with `apple-note-id` set to `id`, creating the
 * envelope if the file had none.
 *
 * Returns the input unchanged when the id is already correct - that's what
 * keeps the byte-for-byte round-trip true for every file we aren't actually
 * changing (see the module comment).
 */
export function setNoteId(frontmatter: string, id: string): string {
  // Never write something `readNoteId` would refuse to read back: the two
  // would disagree forever, and every pull would rewrite the envelope trying
  // to set an id that never sticks.
  if (!isNoteId(id)) {
    return frontmatter;
  }
  if (readNoteId(frontmatter) === id) {
    return frontmatter;
  }

  if (frontmatter.trim() === "") {
    return `---\n${NOTE_ID_KEY}: ${id}\n---\n\n`;
  }

  const doc = parseFrontmatterDocument(frontmatter);
  if (!doc) {
    // Unparseable YAML: the envelope is already broken, and rewriting it
    // wholesale would destroy whatever the user was mid-way through typing.
    // Leave it alone - the note falls back to path matching, which is
    // exactly what an id-less file does.
    return frontmatter;
  }

  doc.set(NOTE_ID_KEY, id);
  return reassemble(frontmatter, doc);
}

/**
 * Removes `apple-note-id` from an envelope - used when a file turns out to
 * be a copy of another note and has to be re-stamped with an id of its own.
 * Leaves the rest of the block (and the file's own formatting) alone.
 */
export function clearNoteId(frontmatter: string): string {
  const doc = parseFrontmatterDocument(frontmatter);
  if (!doc || !doc.has(NOTE_ID_KEY)) {
    return frontmatter;
  }
  doc.delete(NOTE_ID_KEY);
  // An envelope that held nothing but the id has no reason to survive.
  if (String(doc).trim() === "{}" || String(doc).trim() === "") {
    return "";
  }
  return reassemble(frontmatter, doc);
}

/**
 * The real title recorded in a frontmatter envelope, or undefined when there
 * isn't one. Total in the same way `readNoteId` is: broken YAML, a missing
 * key, a non-string value and an empty string all read as "no recorded
 * title", so the caller falls back to the file name.
 */
export function readNoteTitle(frontmatter: string): string | undefined {
  const doc = parseFrontmatterDocument(frontmatter);
  if (!doc) {
    return undefined;
  }
  const value: unknown = doc.get(NOTE_TITLE_KEY);
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  return value;
}

/** Returns `frontmatter` with `apple-note-title` set, creating the envelope
 * if there was none. Unchanged when it already says exactly this. */
export function setNoteTitle(frontmatter: string, title: string): string {
  if (readNoteTitle(frontmatter) === title) {
    return frontmatter;
  }
  if (frontmatter.trim() === "") {
    return `---\n${NOTE_TITLE_KEY}: ${JSON.stringify(title)}\n---\n\n`;
  }
  const doc = parseFrontmatterDocument(frontmatter);
  if (!doc) {
    return frontmatter;
  }
  doc.set(NOTE_TITLE_KEY, title);
  return reassemble(frontmatter, doc);
}

/**
 * Removes `apple-note-title` - what keeps the key rare. A note retitled
 * remotely to something a file name *can* hold gets its real name back and
 * must not keep a stale copy of the old title in frontmatter.
 */
export function clearNoteTitle(frontmatter: string): string {
  const doc = parseFrontmatterDocument(frontmatter);
  if (!doc || !doc.has(NOTE_TITLE_KEY)) {
    return frontmatter;
  }
  doc.delete(NOTE_TITLE_KEY);
  if (String(doc).trim() === "{}" || String(doc).trim() === "") {
    return "";
  }
  return reassemble(frontmatter, doc);
}

/**
 * Assembles the text of a note's working file: the body, under an envelope
 * carrying its id. The single place `clone` and `pull` go through, so the two
 * can't disagree about whether a freshly written file is stamped.
 *
 * Every note carries its id - there is no mode in which one doesn't. Making
 * it optional bought no correctness (nothing about the sync needs the id
 * absent) and cost a second pairing path through `push` forever, so the
 * option was removed in favour of one shape.
 *
 * `frontmatter` is whatever envelope the file already had (empty for a file
 * being created), so a user's own keys survive every rewrite.
 *
 * `unrepresentableTitle` is the note's real title when the file name can't
 * carry it (see `NOTE_TITLE_KEY`), and undefined whenever the name is
 * enough - passing undefined actively *removes* a stale key, which is what
 * keeps the two in step as a note is retitled back and forth across the
 * representable boundary.
 */
export function composeNoteFile(
  frontmatter: string,
  body: string,
  recordName: string,
  unrepresentableTitle?: string | undefined,
): string {
  const stamped = setNoteId(frontmatter, recordName);
  return joinFrontmatter(
    unrepresentableTitle === undefined ? clearNoteTitle(stamped) : setNoteTitle(stamped, unrepresentableTitle),
    body,
  );
}

const FENCE = "---";

/** Parses the YAML *between* an envelope's fences. Returns undefined when
 * the text isn't a fenced envelope at all, or when YAML rejects it. */
function parseFrontmatterDocument(frontmatter: string): Document | undefined {
  const body = envelopeBody(frontmatter);
  if (body === undefined) {
    return undefined;
  }
  const doc = parseDocument(body);
  if (doc.errors.length > 0) {
    return undefined;
  }
  // A frontmatter block is a mapping; a bare scalar or sequence isn't
  // something we can set a key on. An empty document is fine - `set` makes
  // the map.
  if (doc.contents !== null && !isMap(doc.contents)) {
    return undefined;
  }
  return doc;
}

/** The YAML text inside an envelope's `---` fences, or undefined when
 * `frontmatter` isn't shaped like one. Mirrors `splitFrontmatter`'s notion
 * of an envelope: first line exactly `---`, a later line exactly `---`. */
function envelopeBody(frontmatter: string): string | undefined {
  const lines = frontmatter.split("\n");
  if (lines[0] !== FENCE) {
    return undefined;
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FENCE) {
      return lines.slice(1, i).join("\n");
    }
  }
  return undefined;
}

/** Rebuilds an envelope around freshly serialized YAML, preserving whatever
 * trailing blank lines the original had between the closing fence and the
 * note body (`splitFrontmatter` folds those into the envelope). */
function reassemble(original: string, doc: Document): string {
  const lines = original.split("\n");
  let closingFence = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FENCE) {
      closingFence = i;
      break;
    }
  }
  const trailer = closingFence === -1 ? "" : lines.slice(closingFence + 1).join("\n");
  const yaml = String(doc).replace(/\n$/, "");
  return `${FENCE}\n${yaml}\n${FENCE}\n${trailer}`;
}
