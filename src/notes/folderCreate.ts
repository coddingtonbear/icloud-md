/**
 * Planning the Folder records a push needs to create.
 *
 * A note can only be created inside a folder the account actually has, so
 * until now a file in a directory the account didn't know about was refused
 * outright. This turns that directory into a real Notes folder instead.
 *
 * Scope, deliberately narrow (see the folder-creation dev log):
 *
 *  - Only directories that a note is actually going *into* become folders.
 *    A stray empty directory, or one holding nothing this push would sync,
 *    is left alone - creating remote folders for editor scratch dirs would
 *    be a nasty surprise.
 *  - Creation only. A locally *renamed* directory reads as a new folder plus
 *    a set of moves; the folder it left behind stays on the server, empty.
 *    Deleting a remote folder is a separate, riskier feature (there is no
 *    id on a directory to tell a rename from a delete-plus-create), and is
 *    not attempted here.
 *  - Nothing is ever created inside another user's shared area: the folder
 *    would have to live in their zone, under their share's structure.
 *
 * Record names are generated client-side, exactly as note creates do, which
 * is what lets a single push plan a folder and the notes inside it at the
 * same time: the notes can reference the folder's id before it exists.
 */

import path from "node:path";
import { RESERVED_SIBLING_DIR_NAMES, RESERVED_TOP_LEVEL_DIR_NAMES } from "./folderTree.js";
import type { StateDirInfo } from "./folderLayout.js";

/** One Folder record a push intends to create. */
export interface PlannedFolder {
  /** Client-generated record name, usable by dependent writes immediately. */
  recordName: string;
  /** The folder's title, which is simply the directory's own name. */
  title: string;
  /** Vault-root-relative directory this folder corresponds to. */
  dirPath: string;
  /** Parent Folder's record name; absent for a top-level folder. */
  parentRecordName?: string | undefined;
}

/** A directory that cannot become a folder, and why. */
export interface RefusedFolder {
  dirPath: string;
  reason: string;
}

export interface FolderCreatePlan {
  /** Parent-before-child order, so the plan can be executed as-is. */
  folders: PlannedFolder[];
  refusals: RefusedFolder[];
  /** Directory path → the folder record name it will have, planned or existing. */
  dirToRecordName: Map<string, string>;
}

/**
 * A directory name this tool reserves for its own use at some level of the
 * tree, and so must never turn into a folder. `attachments` is reserved
 * inside every folder directory, and `.icloud-md` at the top.
 */
function reservedReason(segment: string, isTopLevel: boolean): string | undefined {
  if (segment.startsWith(".")) {
    // Editor and tooling metadata (.obsidian, .git, .trash): never content.
    return `"${segment}" is a hidden directory - this tool won't create a Notes folder for one`;
  }
  if (RESERVED_SIBLING_DIR_NAMES.includes(segment)) {
    return `"${segment}" is reserved for a folder's downloaded attachments`;
  }
  if (isTopLevel && RESERVED_TOP_LEVEL_DIR_NAMES.includes(segment)) {
    return `"${segment}" is reserved for this tool's own vault state`;
  }
  return undefined;
}

export interface PlanFolderCreatesOptions {
  /** Directories notes are being created in or moved into, vault-root-relative. */
  wantedDirs: Iterable<string>;
  /** The directories the account already has, from `stateDirIndex`. */
  dirIndex: ReadonlyMap<string, StateDirInfo>;
  /** Injectable for tests; defaults to `crypto.randomUUID`. */
  newRecordName?: () => string;
}

/**
 * Works out which directories must become Folder records.
 *
 * Walks each wanted directory from the root down, so an intermediate
 * directory that doesn't exist yet is planned before the one nested inside
 * it, and two notes in sibling directories under the same new parent plan
 * that parent exactly once.
 */
export function planFolderCreates(options: PlanFolderCreatesOptions): FolderCreatePlan {
  const { wantedDirs, dirIndex } = options;
  const newRecordName = options.newRecordName ?? (() => crypto.randomUUID());

  const folders: PlannedFolder[] = [];
  const refusals: RefusedFolder[] = [];
  const dirToRecordName = new Map<string, string>();
  const refusedDirs = new Set<string>();

  for (const [dir, info] of dirIndex) {
    if (info.kind === "folder" && info.folderRecordName !== undefined) {
      dirToRecordName.set(dir, info.folderRecordName);
    }
  }

  // Shallowest first, so a parent is always considered before its children
  // even when the caller hands them over in an arbitrary order.
  const sorted = [...new Set(wantedDirs)].filter((dir) => dir !== "").sort((a, b) => a.split("/").length - b.split("/").length);

  for (const dir of sorted) {
    if (dirToRecordName.has(dir) || refusedDirs.has(dir)) {
      continue;
    }

    const segments = dir.split("/");
    let parentRecordName: string | undefined;
    let refusal: string | undefined;
    let walked = "";

    for (const [depth, segment] of segments.entries()) {
      walked = walked === "" ? segment : `${walked}/${segment}`;

      const existing = dirIndex.get(walked);
      if (existing?.kind === "sharerHome") {
        refusal =
          `"${walked}/" is another user's shared area - folders can only be created in your own Notes, ` +
          "so create it in their shared folder from Notes instead";
        break;
      }
      if (existing?.kind === "folder" && existing.sharedZoneOwner !== undefined) {
        refusal =
          `"${walked}/" is a shared folder - this tool can't create folders inside someone else's share; ` +
          "create it in Notes, pull, then move the file into it";
        break;
      }

      const known = dirToRecordName.get(walked);
      if (known !== undefined) {
        parentRecordName = known;
        continue;
      }

      const reserved = reservedReason(segment, depth === 0);
      if (reserved !== undefined) {
        refusal = reserved;
        break;
      }

      const planned: PlannedFolder = {
        recordName: newRecordName(),
        title: segment,
        dirPath: walked,
        ...(parentRecordName !== undefined ? { parentRecordName } : {}),
      };
      folders.push(planned);
      dirToRecordName.set(walked, planned.recordName);
      parentRecordName = planned.recordName;
    }

    if (refusal !== undefined) {
      refusals.push({ dirPath: dir, reason: refusal });
      refusedDirs.add(dir);
      // Anything planned on the way to a refused directory is unreachable
      // for it, but may still be wanted by a sibling; leave it planned only
      // if some other wanted directory depends on it.
      dropUnreachable(folders, dirToRecordName, sorted, refusedDirs);
    }
  }

  return { folders, refusals, dirToRecordName };
}

/**
 * Removes folders that were planned only on the way into a directory that
 * turned out to be refused, so a refusal never leaves a stray folder behind.
 * A planned folder survives if any still-wanted directory sits at or below
 * it.
 */
function dropUnreachable(
  folders: PlannedFolder[],
  dirToRecordName: Map<string, string>,
  wanted: readonly string[],
  refusedDirs: ReadonlySet<string>,
): void {
  const live = wanted.filter((dir) => !refusedDirs.has(dir));
  for (let i = folders.length - 1; i >= 0; i -= 1) {
    const folder = folders[i]!;
    const needed = live.some((dir) => dir === folder.dirPath || dir.startsWith(`${folder.dirPath}/`));
    if (!needed) {
      folders.splice(i, 1);
      dirToRecordName.delete(folder.dirPath);
    }
  }
}

/** The directory a note file sits in, vault-root-relative ("" at the top). */
export function dirOfFile(file: string): string {
  const dir = path.posix.dirname(file);
  return dir === "." ? "" : dir;
}
