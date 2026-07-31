import { readFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";
import { readBaseCopy } from "./baseCopy.js";
import type { CloneStateNoteEntry, TitleMode } from "./cloneState.js";
import { splitFrontmatter } from "./frontmatter.js";

/**
 * Whether a tracked note's local file still matches its base copy (the last
 * known synced/merged content). "missing" is distinguished from "modified"
 * so callers can treat a vanished file (nothing to lose) differently from a
 * hand-edited one (something to protect - `pull` merges it, `push` uploads
 * it). Shared between `pull` and `push` so the two commands can't disagree
 * about what counts as a local edit.
 */
export type LocalFileState = "clean" | "modified" | "missing";

/**
 * A tracked note's file as it currently sits on disk: its state, and - for
 * anything actually there - the split it was judged on, so a caller that
 * needs the content doesn't read the same file a second time.
 *
 * The envelope is worth having even when the body came back "clean": a
 * frontmatter-only edit is invisible to the comparison below by design, but
 * it isn't nothing. `push` reads `apple-note-title` out of it to find a
 * retitle the body could never express (see `restoreStrippedTitle`).
 */
export type LocalNote =
  | { status: "missing" }
  | { status: "clean" | "modified"; frontmatter: string; body: string };

export async function readLocalNote(
  targetDir: string,
  entry: CloneStateNoteEntry,
  recordName: string,
  titleMode: TitleMode = "in-body",
): Promise<LocalNote> {
  let content: string;
  try {
    content = await readFile(path.join(targetDir, entry.file), "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return { status: "missing" };
    }
    throw cause;
  }

  // `titleMode` matters here for a reason that isn't obvious: under
  // filename-as-title a body can begin with a blank line, and splitting
  // without it folds that line into the envelope, so a freshly cloned note
  // never matches its base copy at all.
  const { frontmatter, body } = splitFrontmatter(content, { filenameAsTitle: titleMode === "filename" });

  const base = await readBaseCopy(targetDir, recordName);
  if (base === undefined) {
    // No base copy on disk for a tracked note shouldn't normally happen, but
    // if it does, we can't verify cleanliness - treat conservatively.
    return { status: "modified", frontmatter, body };
  }
  // Compare body-only: the base copy never carries frontmatter, so a local-
  // only frontmatter edit leaves the body equal to base and stays "clean" -
  // it must not read as a note change (which would trigger a spurious push).
  return { status: body === base ? "clean" : "modified", frontmatter, body };
}

export async function localFileState(
  targetDir: string,
  entry: CloneStateNoteEntry,
  recordName: string,
  titleMode: TitleMode = "in-body",
): Promise<LocalFileState> {
  return (await readLocalNote(targetDir, entry, recordName, titleMode)).status;
}
