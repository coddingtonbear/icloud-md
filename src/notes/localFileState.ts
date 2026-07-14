import { readFile } from "node:fs/promises";
import path from "node:path";
import { readBaseCopy } from "./baseCopy.js";
import type { CloneStateNoteEntry } from "./cloneState.js";

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
  return content === base ? "clean" : "modified";
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
