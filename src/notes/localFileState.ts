import { readFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";
import { readBaseCopy } from "./baseCopy.js";
import type { CloneStateNoteEntry } from "./cloneState.js";
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

export async function localFileState(
  targetDir: string,
  entry: CloneStateNoteEntry,
  recordName: string,
): Promise<LocalFileState> {
  let content: string;
  try {
    content = await readFile(path.join(targetDir, entry.file), "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return "missing";
    }
    throw cause;
  }

  const base = await readBaseCopy(targetDir, recordName);
  if (base === undefined) {
    // No base copy on disk for a tracked note shouldn't normally happen, but
    // if it does, we can't verify cleanliness - treat conservatively.
    return "modified";
  }
  // Compare body-only: the base copy never carries frontmatter, so a local-
  // only frontmatter edit leaves the body equal to base and stays "clean" -
  // it must not read as a note change (which would trigger a spurious push).
  return splitFrontmatter(content).body === base ? "clean" : "modified";
}
