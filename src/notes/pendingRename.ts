import { readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";
import type { CloneState, CloneStateNoteEntry, TitleMode } from "./cloneState.js";
import { noteDirOf } from "./folderLayout.js";
import { splitFrontmatter } from "./frontmatter.js";
import { readNoteId } from "./noteIdFrontmatter.js";

/**
 * Deferred renames: the state behind `pull --defer-renames`.
 *
 * In a filename-as-title vault a remote retitle has to rename the file,
 * because the name is the only place the title lives. Doing that behind an
 * editor's back is the mode's known cost - a rename performed outside
 * Obsidian doesn't trigger its link updating, so wikilinks pointing at the
 * note go stale. `--defer-renames` hands the rename to someone who can do
 * better: pull records the rename it *would* have performed and leaves the
 * file alone, and a consumer (a plugin, a script, a person) carries it out.
 *
 * Between the two, the name on disk knowingly disagrees with the note's
 * title. That is safe rather than merely tolerable, because no path that
 * reads a tracked note ever *re-derives* a title from its file name - push
 * takes the title from the live record (see `restoreStrippedTitle`), and
 * only a file found somewhere *other* than its tracked path is read as a
 * retitle. Settling below runs before anything reasons about which file is
 * which, so a completed rename never reaches that machinery as a mystery
 * move.
 *
 * The one thing a tracked file can say about its own title is an explicit
 * `apple-note-title`, which is not a re-derivation - it's an exact string
 * the user wrote. Push sends that as a retitle and renames nothing; the
 * name catches up here, on the pull that follows, which is why a retitle
 * requested locally and one made on another device arrive by the same
 * road.
 */

/**
 * Where a note with a rename outstanding is supposed to end up: its recorded
 * target name, resolved against the directory its file is actually in.
 * Undefined when nothing is pending, or when the pending name is the one the
 * file already has.
 *
 * The state entry stores a bare name rather than a path exactly so this can
 * be derived: a pull that both retitles and relocates a note moves the file
 * into a different folder after recording the rename, and a stored path
 * would then point into the folder the note had just left.
 */
export function pendingRenameTarget(entry: CloneStateNoteEntry): string | undefined {
  if (entry.pendingRename === undefined || entry.pendingRename === path.posix.basename(entry.file)) {
    return undefined;
  }
  return path.posix.join(noteDirOf(entry.file), entry.pendingRename);
}

export interface PendingRenameSettlement {
  /** True when tracked state changed and so must be persisted. */
  changed: boolean;
  /** Renames carried out here (only ever with `perform`), vault-relative. */
  performed: { from: string; to: string }[];
  /** Renames that couldn't be carried out because something else is already
   * at the target name. Still pending afterwards, deliberately: the note is
   * no worse off than before, and saying so is better than quietly picking a
   * third name nobody asked for. */
  blocked: { file: string; to: string }[];
}

/**
 * Brings pending renames back in line with what actually happened on disk,
 * and - with `perform` - carries out any that are still outstanding.
 *
 * Every command that reads tracked state calls this first, because a note
 * whose file the consumer already moved is not a mystery to be solved by
 * push's id-based move pairing: it is a rename this vault asked for, and
 * recognizing it here keeps it from being re-pushed to iCloud as a retitle
 * of a title that came from iCloud in the first place.
 *
 * `perform` is how a vault gets unstuck: `pull` without `--defer-renames`
 * means "you do it", so it finishes any rename a consumer never got to.
 */
export async function settlePendingRenames(
  targetDir: string,
  notes: CloneState["notes"],
  options: { perform: boolean; titleMode?: TitleMode | undefined },
): Promise<PendingRenameSettlement> {
  const settlement: PendingRenameSettlement = { changed: false, performed: [], blocked: [] };

  for (const [recordName, entry] of Object.entries(notes)) {
    if (entry.pendingRename === undefined) {
      continue;
    }
    const target = pendingRenameTarget(entry);
    if (target === undefined) {
      notes[recordName] = { ...entry, pendingRename: undefined };
      settlement.changed = true;
      continue;
    }

    if (await fileExists(path.join(targetDir, entry.file))) {
      if (!options.perform) {
        continue;
      }
      // Occupied targets stay pending rather than being routed around: the
      // name was free when it was chosen, so something arrived since, and
      // the note keeps a name that at least works until a later pull of the
      // record picks a fresh one through the usual uniquifier.
      if (await fileExists(path.join(targetDir, target))) {
        settlement.blocked.push({ file: entry.file, to: target });
        continue;
      }
      await rename(path.join(targetDir, entry.file), path.join(targetDir, target));
      settlement.performed.push({ from: entry.file, to: target });
      notes[recordName] = { ...entry, file: target, pendingRename: undefined };
      settlement.changed = true;
      continue;
    }

    // The file left the name it was tracked under. If the note is sitting at
    // the target, the consumer did what we asked and that is simply where it
    // lives now. Otherwise the file was renamed elsewhere or deleted, and
    // the pending rename is moot either way - clear it and let the ordinary
    // missing-file machinery (id-based move pairing, or a delete) decide.
    const adopted = (await noteIdAt(targetDir, target, options.titleMode)) === recordName;
    notes[recordName] = { ...entry, ...(adopted ? { file: target } : {}), pendingRename: undefined };
    settlement.changed = true;
  }

  return settlement;
}

/**
 * The `apple-note-id` of whatever is at `file`, or undefined if nothing is
 * there. Checked before adopting a rename as completed so that a file that
 * merely *has* the right name - another note that drifted into it, or
 * something the user created - is never mistaken for this note.
 */
async function noteIdAt(targetDir: string, file: string, titleMode: TitleMode = "in-body"): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(targetDir, file), "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return undefined;
    }
    throw cause;
  }
  return readNoteId(splitFrontmatter(raw, { filenameAsTitle: titleMode === "filename" }).frontmatter);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (cause) {
    if (isEnoent(cause)) {
      return false;
    }
    throw cause;
  }
}
