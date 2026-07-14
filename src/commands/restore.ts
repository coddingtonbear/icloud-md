import { writeFile } from "node:fs/promises";
import path from "node:path";
import { readBaseCopy } from "../notes/baseCopy.js";
import { readCloneState } from "../notes/cloneState.js";

/**
 * Discards a tracked note's local edits, overwriting it with its base copy -
 * the last-known-synced text `push`/`pull` treat as "clean". Purely local,
 * no network call. The general escape hatch for any refusal that otherwise
 * leaves a note stuck with no way back to a clean state short of hand-editing
 * the file: an attachment-bearing note `push` will never accept, unresolved
 * conflict markers the user wants to abandon rather than resolve, etc.
 */
export async function runRestore(targetDir: string, fileArg: string): Promise<void> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new Error(
      `${targetDir} doesn't look like a cloned notes directory (no .icloud-notes-sync/state.json) - run "clone" first.`,
    );
  }

  const fileName = path.basename(fileArg);
  const match = Object.entries(state.notes).find(([, entry]) => entry.file === fileName);
  if (!match) {
    throw new Error(`"${fileName}" isn't a tracked note in ${targetDir} (check the file name and try again).`);
  }
  const [recordName, entry] = match;

  const base = await readBaseCopy(targetDir, recordName);
  if (base === undefined) {
    throw new Error(`"${fileName}" has no base copy to restore to - this shouldn't happen for a tracked note.`);
  }

  await writeFile(path.join(targetDir, entry.file), base, "utf-8");
  console.log(`Restored ${entry.file} to match the last synced copy.`);
}
