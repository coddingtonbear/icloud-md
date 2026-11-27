import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readBaseCopy } from "../notes/baseCopy.js";
import { openVault } from "../notes/vaultMigrations.js";
import { joinFrontmatter, splitFrontmatter } from "../notes/frontmatter.js";
import { composeNoteFile, setNoteTitle } from "../notes/noteIdFrontmatter.js";
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
  const state = await openVault(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const { recordName, entry } = resolveTrackedNote(state, fileArg, targetDir);

  const base = await readBaseCopy(targetDir, recordName);
  if (base === undefined) {
    throw new Error(`"${entry.file}" has no base copy to restore to - this shouldn't happen for a tracked note.`);
  }

  // A deleted working file is a supported restore target (arguably the most
  // useful one) and has no envelope to keep, so it gets a fresh one the way
  // `pull` writes its own "missing locally" branch: the note's id, plus the
  // `apple-note-title` the last sync recorded. Without the key, `push` would
  // read its absence as a request to retitle the note to its file name.
  const filePath = path.join(targetDir, entry.file);
  let existing: string;
  try {
    existing = await readFile(filePath, "utf-8");
  } catch (cause) {
    if (!isEnoent(cause)) {
      throw cause;
    }
    await writeFile(filePath, composeNoteFile("", base, recordName, entry.frontmatterTitle), "utf-8");
    return { file: entry.file };
  }

  // Split with the vault's shape in mind: under filename-as-title the body
  // can begin with a blank line, and folding it into the envelope here would
  // put it back *above* the restored body on every restore.
  const filenameAsTitle = state.titleMode === "filename";
  const { frontmatter } = splitFrontmatter(existing, { filenameAsTitle });
  // There the key is part of what's restored: a removed or edited
  // `apple-note-title` is a pending retitle, so the file isn't back to clean
  // until it says what the last sync recorded. Only a recorded key is put
  // back - state that predates `frontmatterTitle` can't say a key is wrong.
  const restoredFrontmatter =
    filenameAsTitle && entry.frontmatterTitle !== undefined ? setNoteTitle(frontmatter, entry.frontmatterTitle) : frontmatter;
  await writeFile(filePath, joinFrontmatter(restoredFrontmatter, base), "utf-8");
  return { file: entry.file };
}
