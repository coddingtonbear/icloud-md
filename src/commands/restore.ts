import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readBaseCopy } from "../notes/baseCopy.js";
import { readCloneState } from "../notes/cloneState.js";
import { joinFrontmatter, splitFrontmatter } from "../notes/frontmatter.js";
import { isEnoent } from "../fsUtil.js";
import { resolveTrackedNote } from "../notes/trackedFile.js";
import { NotClonedDirectoryError } from "../errors.js";

export interface RestoreResult {
  file: string;
}

/**
 * Discards a tracked note's local edits, overwriting it with its base copy -
 * the last-known-synced text `push`/`pull` treat as "clean". Purely local,
 * no network call. The general escape hatch for any refusal that otherwise
 * leaves a note stuck with no way back to a clean state short of hand-editing
 * the file: an attachment-bearing note `push` will never accept, unresolved
 * conflict markers the user wants to abandon rather than resolve, etc.
 *
 * Base copies are body-only (that's exactly what `localFileState` compares
 * against), so the file's local-only frontmatter has to be carried across by
 * hand here - it lives nowhere else, was never pushed, and no `pull` would
 * bring it back. `pull` and `push` already do the same around their own
 * working-file writes; this was the one write path that didn't.
 */
export async function runRestore(targetDir: string, fileArg: string): Promise<RestoreResult> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const { recordName, entry } = resolveTrackedNote(state, fileArg, targetDir);

  const base = await readBaseCopy(targetDir, recordName);
  if (base === undefined) {
    throw new Error(`"${entry.file}" has no base copy to restore to - this shouldn't happen for a tracked note.`);
  }

  // A deleted working file is a supported restore target (arguably the most
  // useful one) and has no envelope to keep, so a missing file yields an empty
  // frontmatter rather than an error - matching how `pull` handles its own
  // "missing locally" branch.
  const filePath = path.join(targetDir, entry.file);
  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch (cause) {
    if (!isEnoent(cause)) {
      throw cause;
    }
  }

  const { frontmatter } = splitFrontmatter(existing);
  await writeFile(filePath, joinFrontmatter(frontmatter, base), "utf-8");
  return { file: entry.file };
}
