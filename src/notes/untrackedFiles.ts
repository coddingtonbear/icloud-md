import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode, isEnoent } from "../fsUtil.js";
import type { CloneState, TitleMode } from "./cloneState.js";
import { splitFrontmatter } from "./frontmatter.js";
import { readNoteId } from "./noteIdFrontmatter.js";
import { groupNoteIdClaims, type UntrackedFile } from "./noteIdPairing.js";

/** Untracked `.md` files anywhere in the vault, as vault-root-relative
 * POSIX paths - the raw material for push's create half, the local-move
 * pairing, and the loose-file/unknown-folder refusals, and for pull finding
 * where a note moved by hand went. Skips dot-directories (the state dir,
 * .git) and the reserved per-folder `attachments/` directories; `.md` files
 * found in the latter are returned separately, so push's plan can say
 * they're being ignored rather than skip them in silence. A `.md` this clone
 * already tracks - a markdown file attached to a note, or a note that lives
 * under such a path - belongs there and isn't reported. */
export async function listUntrackedMarkdownFiles(
  targetDir: string,
  notes: CloneState["notes"],
  attachments: CloneState["attachments"] = undefined,
): Promise<{ files: string[]; inAttachmentDirs: string[] }> {
  const tracked = new Set([
    ...Object.values(notes).map((entry) => entry.file),
    ...Object.values(attachments ?? {}).map((attachment) => attachment.file),
  ]);
  const found: string[] = [];
  const inAttachmentDirs: string[] = [];

  const walk = async (dir: string, inAttachments: boolean): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(path.join(targetDir, dir), { withFileTypes: true });
    } catch (cause) {
      if (isEnoent(cause)) {
        return;
      }
      throw cause;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) {
        continue;
      }
      const relative = dir === "" ? dirent.name : `${dir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        await walk(relative, inAttachments || dirent.name.toLowerCase() === "attachments");
      } else if (dirent.isFile() && dirent.name.endsWith(".md") && !tracked.has(relative)) {
        (inAttachments ? inAttachmentDirs : found).push(relative);
      }
    }
  };

  await walk("", false);
  return { files: found.sort(), inAttachmentDirs: inAttachmentDirs.sort() };
}

/** Untracked files by the `apple-note-id` they carry, plus the ones that
 * couldn't be read to find out. */
export interface UntrackedNoteIdIndex {
  claims: Map<string, string[]>;
  /** Files that exist but weren't readable - any one of them may be a moved
   * note, which is worth saying when a note then can't be followed. */
  unreadable: string[];
}

/**
 * Every untracked file that carries an `apple-note-id`, grouped by that id.
 * A file with no usable id isn't in it at all: without one, which note a
 * file is can only be guessed, and pull doesn't guess (push's content and
 * basename fallbacks are for planning a move the user then confirms by
 * pushing, not for deciding where remote text gets written).
 *
 * A file that can't be read (gone since the directory was listed, or not
 * readable) is left out rather than failing the pull: it can't be the
 * target of a merge either way, and before this index existed a missing
 * note never read unrelated files at all. An unreadable one is listed in
 * `unreadable`, so the recreate that follows can say why.
 */
export async function indexUntrackedNoteIds(
  targetDir: string,
  notes: CloneState["notes"],
  titleMode: TitleMode = "in-body",
): Promise<UntrackedNoteIdIndex> {
  const untracked: UntrackedFile[] = [];
  const unreadable: string[] = [];
  for (const file of (await listUntrackedMarkdownFiles(targetDir, notes)).files) {
    let raw: string;
    try {
      raw = await readFile(path.join(targetDir, file), "utf-8");
    } catch (cause) {
      if (isEnoent(cause)) {
        continue;
      }
      if (hasErrnoCode(cause, "EACCES")) {
        unreadable.push(file);
        continue;
      }
      throw cause;
    }
    const noteId = readNoteId(splitFrontmatter(raw, { filenameAsTitle: titleMode === "filename" }).frontmatter);
    untracked.push({ file, noteId });
  }
  return { claims: groupNoteIdClaims(untracked), unreadable };
}

/** Drops `file` from an index built by `indexUntrackedNoteIds`, once pull
 * has written a note of its own there: the file is no longer the untracked
 * copy the index recorded, and following a move into it would merge one
 * note's text into another's. */
export function forgetIndexedFile(index: UntrackedNoteIdIndex, file: string): void {
  for (const [noteId, files] of index.claims) {
    const remaining = files.filter((claimant) => claimant !== file);
    if (remaining.length === 0) {
      index.claims.delete(noteId);
    } else if (remaining.length !== files.length) {
      index.claims.set(noteId, remaining);
    }
  }
  index.unreadable = index.unreadable.filter((unreadable) => unreadable !== file);
}
