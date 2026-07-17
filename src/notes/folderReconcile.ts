import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";
import { readBaseCopy, writeBaseCopy } from "./baseCopy.js";
import type { CloneState } from "./cloneState.js";
import { uniqueFileName } from "./filename.js";
import { expectedNoteDir, noteDirOf, type VaultLayout } from "./folderLayout.js";

export interface Relocation {
  from: string;
  to: string;
}

/**
 * Moves every tracked note (and its attachments) whose on-disk directory no
 * longer matches the current layout - the tail half of pull's tree
 * reconciliation, covering remote folder renames/moves and remote
 * note-moves between folders. "Remote wins": local placement is never
 * consulted, only reported via the returned relocations.
 *
 * Mechanics per note: the file keeps its basename unless the target
 * directory already has it (Finder-style " 2" then applies); its
 * attachments move into the target's `attachments/`, and in the rare case
 * an attachment basename collides there, the note body's (and base copy's)
 * link is rewritten to match, identically in both so the note doesn't start
 * reading as locally modified. A note whose file is missing locally is left
 * alone - recreating missing files stays `pull`'s record-processing
 * concern.
 */
export async function reconcileNotePlacements(
  targetDir: string,
  layout: VaultLayout,
  notes: CloneState["notes"],
  attachments: NonNullable<CloneState["attachments"]>,
): Promise<Relocation[]> {
  const moves: Array<{ recordName: string; toDir: string }> = [];
  const claimedNames = new Map<string, Set<string>>();
  const claimedAttachmentNames = new Map<string, Set<string>>();

  for (const [recordName, entry] of Object.entries(notes).sort(([a], [b]) => a.localeCompare(b))) {
    const toDir = expectedNoteDir(layout, entry);
    if (toDir === undefined || toDir === noteDirOf(entry.file)) {
      claim(claimedNames, noteDirOf(entry.file), path.posix.basename(entry.file));
      continue;
    }
    moves.push({ recordName, toDir });
  }
  const movingNotes = new Set(moves.map((move) => move.recordName));
  for (const attachment of Object.values(attachments)) {
    if (!movingNotes.has(attachment.noteRecordName)) {
      claim(claimedAttachmentNames, noteDirOf(path.posix.dirname(attachment.file)), path.posix.basename(attachment.file));
    }
  }

  const relocations: Relocation[] = [];
  for (const move of moves) {
    const entry = notes[move.recordName];
    if (!entry) {
      continue;
    }
    const fromFile = entry.file;
    const targetNames = names(claimedNames, move.toDir);
    const baseName = uniqueFileName(path.posix.basename(fromFile), targetNames);
    const toFile = path.posix.join(move.toDir, baseName);

    await mkdir(path.dirname(path.join(targetDir, toFile)), { recursive: true });
    if (!(await tryRename(path.join(targetDir, fromFile), path.join(targetDir, toFile)))) {
      // Missing locally (deleted or moved by hand); leave tracking at the
      // old path - push/status own that conversation.
      claim(claimedNames, noteDirOf(fromFile), path.posix.basename(fromFile));
      continue;
    }
    targetNames.add(baseName);
    notes[move.recordName] = { ...entry, file: toFile };
    relocations.push({ from: fromFile, to: toFile });

    for (const [attachmentRecordName, attachment] of Object.entries(attachments)) {
      if (attachment.noteRecordName !== move.recordName) {
        continue;
      }
      const targetAttachmentNames = names(claimedAttachmentNames, move.toDir);
      const oldBase = path.posix.basename(attachment.file);
      const newBase = uniqueFileName(oldBase, targetAttachmentNames);
      const toAttachment = path.posix.join(move.toDir, "attachments", newBase);

      await mkdir(path.dirname(path.join(targetDir, toAttachment)), { recursive: true });
      if (!(await tryRename(path.join(targetDir, attachment.file), path.join(targetDir, toAttachment)))) {
        continue;
      }
      targetAttachmentNames.add(newBase);
      attachments[attachmentRecordName] = { ...attachment, file: toAttachment };
      if (newBase !== oldBase) {
        await rewriteAttachmentLink(targetDir, toFile, move.recordName, oldBase, newBase);
      }
    }
  }
  return relocations;
}

/**
 * Best-effort removal of directories the previous layout used but the
 * current one doesn't - after a folder rename, the old directory should
 * vanish once its contents moved. Never touches a directory that still has
 * anything in it (untracked local files stay put, and stay visible).
 */
export async function removeStaleDirs(targetDir: string, previousDirs: readonly string[], currentDirs: ReadonlySet<string>): Promise<void> {
  const stale = previousDirs.filter((dir) => dir !== "" && !currentDirs.has(dir));
  // Deepest paths first so children empty out before their parents.
  stale.sort((a, b) => b.split("/").length - a.split("/").length);
  for (const dir of stale) {
    await tryRmdir(path.join(targetDir, dir, "attachments"));
    await tryRmdir(path.join(targetDir, dir));
  }
}

/** Rewrites a moved attachment's markdown link in the note file and its
 * base copy - identically in both, so the rewrite never reads as a local
 * edit. Links are URI-encoded per segment (see formatAttachmentMarkdown). */
async function rewriteAttachmentLink(
  targetDir: string,
  noteFile: string,
  recordName: string,
  oldBase: string,
  newBase: string,
): Promise<void> {
  const oldLink = `attachments/${encodeURIComponent(oldBase)}`;
  const newLink = `attachments/${encodeURIComponent(newBase)}`;
  const notePath = path.join(targetDir, noteFile);

  try {
    const content = await readFile(notePath, "utf-8");
    await writeFile(notePath, content.split(oldLink).join(newLink), "utf-8");
  } catch (cause) {
    if (!isEnoent(cause)) {
      throw cause;
    }
  }
  const base = await readBaseCopy(targetDir, recordName);
  if (base !== undefined) {
    await writeBaseCopy(targetDir, recordName, base.split(oldLink).join(newLink));
  }
}

async function tryRename(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (cause) {
    if (isEnoent(cause)) {
      return false;
    }
    throw cause;
  }
}

async function tryRmdir(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch {
    // Not empty, doesn't exist, or otherwise unremovable - all fine; this
    // cleanup is strictly best-effort.
  }
}

function names(byDir: Map<string, Set<string>>, dir: string): Set<string> {
  let set = byDir.get(dir);
  if (!set) {
    set = new Set();
    byDir.set(dir, set);
  }
  return set;
}

function claim(byDir: Map<string, Set<string>>, dir: string, name: string): void {
  names(byDir, dir).add(name);
}
