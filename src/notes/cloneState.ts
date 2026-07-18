import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CorruptStateFileError, UnsupportedVaultLayoutError } from "../errors.js";
import { isEnoent } from "../fsUtil.js";

export interface CloneStateNoteEntry {
  file: string;
  recordChangeTag: string;
  modificationDate: number;
  /**
   * For a note shared *with* this account: the sharer's ownerRecordName,
   * i.e. which shared-database zone the note lives in. Absent for the
   * account's own (private-database) notes.
   */
  sharedZoneOwner?: string | undefined;
  /**
   * Set when this note contains content this tool couldn't fully parse (an
   * unresolvable embed, or unrecognized structure) - see the Safety
   * Guarantee Audit dev notes. Purely informational: `push` never trusts
   * this field, re-deriving the same check fresh from the live remote
   * record every time. Absent when the note is fully publishable.
   */
  unpublishableReason?: string | undefined;
  /**
   * The Folder record this note lives in, resolving into `folders` - the
   * note's directory derives from that folder's tree position. Absent for
   * shared notes (their Folder reference points into the sharer's zone,
   * whose folder records we can't read - see the folders doc) and in state
   * files written before folder support.
   */
  folderRecordName?: string | undefined;
}

/** One synced Apple Notes folder - see the folders doc for the tree design. */
export interface CloneStateFolderEntry {
  /** Decoded folder title as of the last sync ("Recipes"). */
  name: string;
  /** Parent Folder recordName for a nested folder; absent for top-level. */
  parentRecordName?: string | undefined;
  /**
   * This folder's directory name on disk - sanitized and uniquified among
   * siblings; the full path derives from ancestors' dirNames. Persisted so
   * names stay stable across pulls (buildFolderTree's preferredDirNames).
   */
  dirName: string;
  /**
   * For a folder shared *with* this account (a whole shared folder): the
   * sharer's ownerRecordName. Its tree roots under that sharer's home
   * directory (see `sharerHomes`) instead of the vault root. Absent for the
   * account's own folders.
   */
  sharedZoneOwner?: string | undefined;
  /**
   * Shared folders only: this account's permission on the folder's share
   * ("READ_WRITE" / "READ_ONLY"), from the `cloudkit.share` record's
   * `currentUserParticipant` (nested folders inherit the shared root's).
   * Absent when unknown - e.g. state written before this field existed,
   * where an incremental pull may never re-send the share record; push then
   * attempts the write and lets the server be the authority.
   */
  permission?: string | undefined;
}

/** One sharer's top-level home directory - where everything shared by that
 * user lives: their shared folders as real subdirectories, and their
 * individually-shared notes loose at its top (those notes' folder
 * membership points into the sharer's unreadable private tree - see the
 * folders doc, 2026-07-16T21:34). */
export interface CloneStateSharerHomeEntry {
  /** Display name as of the last sync - the share's OWNER participant's
   * name, email, or phone, falling back to the opaque ownerRecordName. */
  name: string;
  /** Directory name on disk (top-level, uniquified alongside the account's
   * own root folders). */
  dirName: string;
}

export interface CloneStateAttachmentEntry {
  /** Path relative to the vault root, e.g. "attachments/_7130093.jpeg". */
  file: string;
  /** The `Media` record backing this attachment's actual bytes (distinct
   * from the `Attachment` record this entry is keyed by - see dev notes). */
  mediaRecordName: string;
  /** The Media record's `Asset.fileChecksum` as of the last download - the
   * change-detection signal `pull` compares against before re-downloading. */
  mediaFileChecksum: string;
  /** Which note this attachment belongs to, so it can be cleaned up if that
   * note is deleted or dropped from tracking. */
  noteRecordName: string;
}

export interface CloneStateTableAttachmentEntry {
  /** Which note this table attachment belongs to, so it can be cleaned up
   * if that note is deleted or dropped from tracking. */
  noteRecordName: string;
}

export interface CloneStateTrashedEntry {
  /** The vault file this note lived at before it was trashed - what
   * `delete --hard <file>` resolves against once the file itself and the
   * `notes` entry are gone. */
  file: string;
  /** ms epoch of when this tool moved the note to Recently Deleted. */
  trashedAt: number;
}

export interface CloneStateAccount {
  appleId: string;
  dsid: string;
}

export interface CloneState {
  /**
   * On-disk layout generation. Version 2 is the folder-tree layout (notes
   * inside folder directories, per-folder attachments). State files without
   * the field are the original flat layout, which this tool no longer
   * reads - readCloneState fails loudly telling the user to re-clone
   * (backward compatibility deliberately waived, see the folders doc,
   * 2026-07-16T21:10). writeCloneState always stamps the current version.
   */
  layoutVersion?: number | undefined;
  /**
   * Which Apple ID this folder was cloned for - resolves to that account's
   * own session under `~/.config/icloud-notes-sync/accounts/<dsid>/` (see
   * `accountStore.ts`), never anything secret stored here. Absent only for
   * folders cloned before per-folder account binding existed; `pull`/`push`/
   * `reauthenticate` refuse to run without it (see `UnboundAccountError`).
   */
  account?: CloneStateAccount | undefined;
  /** CloudKit syncToken as of this snapshot; a future `pull` resumes incremental sync from here. */
  syncToken: string | undefined;
  /**
   * Per-shared-zone syncTokens, keyed by the zone owner's recordName.
   * Absent entirely in state files written before shared-note support.
   */
  sharedZoneSyncTokens?: Record<string, string> | undefined;
  /**
   * This vault's identity in the Notes CRDT (base64 of 16 random bytes) -
   * text pushed from here is recorded in each note's replica table under
   * this id. Generated by the first `push` and stable per vault afterwards,
   * so repeated pushes read as one continuous editor rather than a parade
   * of one-shot replicas.
   */
  replicaId?: string | undefined;
  notes: Record<string, CloneStateNoteEntry>;
  /**
   * The account's folder tree as of the last sync, keyed by the Folder
   * record's recordName (including `DefaultFolder-CloudKit`; never Trash).
   * Shared folders appear here too, tagged with their `sharedZoneOwner`.
   */
  folders?: Record<string, CloneStateFolderEntry> | undefined;
  /** Per-sharer home directories, keyed by the sharer's ownerRecordName. */
  sharerHomes?: Record<string, CloneStateSharerHomeEntry> | undefined;
  /** Downloaded attachments, keyed by the `Attachment` record's recordName
   * (the identifier embedded in the owning note's body). Absent entirely in
   * state files written before Phase 4. */
  attachments?: Record<string, CloneStateAttachmentEntry> | undefined;
  /** Table attachments currently referenced by a note, keyed by the
   * `Attachment` record's recordName - same identifier space as
   * `attachments`, but tracked separately since a table has no downloaded
   * file (its content is rendered inline as markdown) and so none of
   * `CloneStateAttachmentEntry`'s file/checksum fields apply. Exists so a
   * note's table recordNames are known outside of a single pull's in-memory
   * scope (version history lookups, staleness cleanup). Absent entirely in
   * state files written before this tracking existed. */
  tableAttachments?: Record<string, CloneStateTableAttachmentEntry> | undefined;
  /**
   * Notes this tool moved to Recently Deleted (via `delete` or `push`),
   * keyed by recordName. Kept so a soft-deleted note stays reachable for
   * `delete --hard <file>` after its file and `notes` entry are gone - see
   * the "trash registry" design in the project notes (2026-07-16T11:10).
   * Entries prune when a hard delete completes or a later `pull` sees the
   * record's real server-side deletion tombstone. Absent entirely in state
   * files written before the trash registry existed.
   */
  trashed?: Record<string, CloneStateTrashedEntry> | undefined;
}

export const STATE_DIR_NAME = ".icloud-notes-sync";
export const STATE_FILE_NAME = "state.json";

/** The on-disk layout generation this build reads and writes - see
 * CloneState.layoutVersion. */
export const CURRENT_LAYOUT_VERSION = 2;

export async function writeCloneState(targetDir: string, state: CloneState): Promise<void> {
  const dir = path.join(targetDir, STATE_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const stamped: CloneState = { ...state, layoutVersion: CURRENT_LAYOUT_VERSION };
  await writeFile(path.join(dir, STATE_FILE_NAME), JSON.stringify(stamped, null, 2) + "\n", "utf-8");
}

export async function readCloneState(targetDir: string): Promise<CloneState | undefined> {
  const filePath = path.join(targetDir, STATE_DIR_NAME, STATE_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return undefined;
    }
    throw cause;
  }

  const parsed: unknown = JSON.parse(raw);
  return assertCloneState(parsed, filePath);
}

function assertCloneState(value: unknown, filePath: string): CloneState {
  if (typeof value !== "object" || value === null || !isRecord(value) || !isRecord(value.notes)) {
    throw new CorruptStateFileError(`${filePath} does not look like a valid state file (missing "notes" object).`);
  }

  if (value.layoutVersion !== CURRENT_LAYOUT_VERSION) {
    throw new UnsupportedVaultLayoutError(path.dirname(path.dirname(filePath)));
  }

  const syncToken = typeof value.syncToken === "string" ? value.syncToken : undefined;
  const notes: Record<string, CloneStateNoteEntry> = {};

  for (const [recordName, entry] of Object.entries(value.notes)) {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.recordChangeTag !== "string" ||
      typeof entry.modificationDate !== "number"
    ) {
      throw new CorruptStateFileError(`${filePath} has a malformed entry for note "${recordName}".`);
    }
    notes[recordName] = {
      file: entry.file,
      recordChangeTag: entry.recordChangeTag,
      modificationDate: entry.modificationDate,
      sharedZoneOwner: typeof entry.sharedZoneOwner === "string" ? entry.sharedZoneOwner : undefined,
      unpublishableReason: typeof entry.unpublishableReason === "string" ? entry.unpublishableReason : undefined,
      folderRecordName: typeof entry.folderRecordName === "string" ? entry.folderRecordName : undefined,
    };
  }

  let folders: Record<string, CloneStateFolderEntry> | undefined;
  if (isRecord(value.folders)) {
    folders = {};
    for (const [recordName, entry] of Object.entries(value.folders)) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.dirName !== "string") {
        throw new CorruptStateFileError(`${filePath} has a malformed entry for folder "${recordName}".`);
      }
      folders[recordName] = {
        name: entry.name,
        parentRecordName: typeof entry.parentRecordName === "string" ? entry.parentRecordName : undefined,
        dirName: entry.dirName,
        sharedZoneOwner: typeof entry.sharedZoneOwner === "string" ? entry.sharedZoneOwner : undefined,
        permission: typeof entry.permission === "string" ? entry.permission : undefined,
      };
    }
  }

  let sharerHomes: Record<string, CloneStateSharerHomeEntry> | undefined;
  if (isRecord(value.sharerHomes)) {
    sharerHomes = {};
    for (const [owner, entry] of Object.entries(value.sharerHomes)) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.dirName !== "string") {
        throw new CorruptStateFileError(`${filePath} has a malformed entry for sharer home "${owner}".`);
      }
      sharerHomes[owner] = { name: entry.name, dirName: entry.dirName };
    }
  }

  const replicaId = typeof value.replicaId === "string" ? value.replicaId : undefined;

  let sharedZoneSyncTokens: Record<string, string> | undefined;
  if (isRecord(value.sharedZoneSyncTokens)) {
    sharedZoneSyncTokens = {};
    for (const [owner, token] of Object.entries(value.sharedZoneSyncTokens)) {
      if (typeof token !== "string") {
        throw new CorruptStateFileError(`${filePath} has a malformed shared-zone syncToken for owner "${owner}".`);
      }
      sharedZoneSyncTokens[owner] = token;
    }
  }

  let attachments: Record<string, CloneStateAttachmentEntry> | undefined;
  if (isRecord(value.attachments)) {
    attachments = {};
    for (const [recordName, entry] of Object.entries(value.attachments)) {
      if (
        !isRecord(entry) ||
        typeof entry.file !== "string" ||
        typeof entry.mediaRecordName !== "string" ||
        typeof entry.mediaFileChecksum !== "string" ||
        typeof entry.noteRecordName !== "string"
      ) {
        throw new CorruptStateFileError(`${filePath} has a malformed entry for attachment "${recordName}".`);
      }
      attachments[recordName] = {
        file: entry.file,
        mediaRecordName: entry.mediaRecordName,
        mediaFileChecksum: entry.mediaFileChecksum,
        noteRecordName: entry.noteRecordName,
      };
    }
  }

  let tableAttachments: Record<string, CloneStateTableAttachmentEntry> | undefined;
  if (isRecord(value.tableAttachments)) {
    tableAttachments = {};
    for (const [recordName, entry] of Object.entries(value.tableAttachments)) {
      if (!isRecord(entry) || typeof entry.noteRecordName !== "string") {
        throw new CorruptStateFileError(`${filePath} has a malformed entry for table attachment "${recordName}".`);
      }
      tableAttachments[recordName] = { noteRecordName: entry.noteRecordName };
    }
  }

  let trashed: Record<string, CloneStateTrashedEntry> | undefined;
  if (isRecord(value.trashed)) {
    trashed = {};
    for (const [recordName, entry] of Object.entries(value.trashed)) {
      if (!isRecord(entry) || typeof entry.file !== "string" || typeof entry.trashedAt !== "number") {
        throw new CorruptStateFileError(`${filePath} has a malformed entry for trashed note "${recordName}".`);
      }
      trashed[recordName] = { file: entry.file, trashedAt: entry.trashedAt };
    }
  }

  let account: CloneStateAccount | undefined;
  if (value.account !== undefined) {
    if (!isRecord(value.account) || typeof value.account.appleId !== "string" || typeof value.account.dsid !== "string") {
      throw new CorruptStateFileError(`${filePath} has a malformed "account" field.`);
    }
    account = { appleId: value.account.appleId, dsid: value.account.dsid };
  }

  return {
    layoutVersion: CURRENT_LAYOUT_VERSION,
    account,
    syncToken,
    sharedZoneSyncTokens,
    replicaId,
    notes,
    folders,
    sharerHomes,
    attachments,
    tableAttachments,
    trashed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
