import path from "node:path";
import type { CloudKitRecord, ShareParticipant } from "../cloudkit/databaseClient.js";
import type { CloneState, CloneStateFolderEntry, CloneStateNoteEntry, CloneStateSharerHomeEntry } from "./cloneState.js";
import {
  buildFolderTree,
  decodeFolderRecord,
  DEFAULT_FOLDER_RECORD_NAME,
  RESERVED_SIBLING_DIR_NAMES,
  RESERVED_TOP_LEVEL_DIR_NAMES,
  sanitizeFolderDirName,
  type FolderInfo,
  type FolderTreeNode,
} from "./folderTree.js";

/** One shared zone's raw records, tagged with its owner - the shape both
 * clone and pull already have in hand when building the layout. */
export interface SharedZoneRecords {
  ownerRecordName: string;
  records: readonly CloudKitRecord[];
}

/**
 * The vault's complete directory layout for one sync run: every folder's
 * (and sharer home's) vault-root-relative directory path, plus the state
 * maps that persist the name assignments for the next run.
 */
export interface VaultLayout {
  /** Folder recordName → vault-root-relative dirPath (own and shared). */
  folderDirs: Map<string, string>;
  /** Sharer ownerRecordName → the sharer's top-level home dirPath. */
  sharerHomeDirs: Map<string, string>;
  stateFolders: Record<string, CloneStateFolderEntry>;
  stateSharerHomes: Record<string, CloneStateSharerHomeEntry>;
  /** Every directory the layout implies, for materialization (mkdir -p). */
  allDirs: string[];
}

/**
 * Builds the layout from this run's records, carried previous state (so an
 * incremental pull still knows folders the server didn't re-send, and
 * directory names stay stable), and the sharers' zones.
 *
 * Own folders root at the vault top level; each shared zone's folders form
 * their own tree rooted under that sharer's home directory. Sharer homes
 * share the top-level namespace with the account's own root folders.
 */
export function buildVaultLayout(
  privateRecords: readonly CloudKitRecord[],
  sharedZones: readonly SharedZoneRecords[],
  previous?: Pick<CloneState, "folders" | "sharerHomes">,
): VaultLayout {
  // Own folders: previous state as the base, overlaid with this run's
  // records (which may add, rename, re-parent, or tombstone).
  const ownFolders = mergeFolderInfos(
    Object.entries(previous?.folders ?? {})
      .filter(([, entry]) => entry.sharedZoneOwner === undefined)
      .map(([recordName, entry]) => ({ recordName, title: entry.name, parentRecordName: entry.parentRecordName })),
    privateRecords,
  );

  // A folder keeps its existing directory name only while its *title* is
  // unchanged - a remote rename gets a freshly derived directory name, and
  // the pull-side reconciler moves the contents (see folderReconcile.ts).
  // Everything else keeps its name for stability across sibling churn.
  const currentTitles = new Map<string, string>();
  for (const info of ownFolders) {
    currentTitles.set(info.recordName, info.title);
  }
  for (const zone of sharedZones) {
    for (const record of zone.records) {
      const decoded = record.deleted !== true ? decodeFolderRecord(record) : undefined;
      if (decoded) {
        currentTitles.set(decoded.recordName, decoded.title);
      }
    }
  }
  const preferredDirNames = new Map<string, string>();
  for (const [recordName, entry] of Object.entries(previous?.folders ?? {})) {
    const currentTitle = currentTitles.get(recordName);
    if (currentTitle === undefined || currentTitle === entry.name) {
      preferredDirNames.set(recordName, entry.dirName);
    }
  }

  const ownTree = buildFolderTree(ownFolders, preferredDirNames);

  const folderDirs = new Map<string, string>();
  const stateFolders: Record<string, CloneStateFolderEntry> = {};
  const allDirs: string[] = [];
  for (const node of ownTree.byRecordName.values()) {
    folderDirs.set(node.recordName, node.dirPath);
    stateFolders[node.recordName] = { name: node.title, parentRecordName: node.parentRecordName, dirName: node.dirName };
    allDirs.push(node.dirPath);
  }

  // Sharer homes join the top-level namespace the account's own root
  // folders (and the reserved names) already occupy.
  const topLevelClaimed = new Set<string>(
    [...RESERVED_TOP_LEVEL_DIR_NAMES, ...RESERVED_SIBLING_DIR_NAMES].map((name) => name.toLowerCase()),
  );
  for (const root of ownTree.roots) {
    topLevelClaimed.add(root.dirName.toLowerCase());
  }

  const sharerHomeDirs = new Map<string, string>();
  const stateSharerHomes: Record<string, CloneStateSharerHomeEntry> = {};
  const orderedZones = [...sharedZones].sort((a, b) => a.ownerRecordName.localeCompare(b.ownerRecordName));

  // Previous homes keep their directories first, exactly like folders do.
  for (const preferPrevious of [true, false]) {
    for (const zone of orderedZones) {
      const previousHome = previous?.sharerHomes?.[zone.ownerRecordName];
      if ((previousHome !== undefined) !== preferPrevious) {
        continue;
      }
      // Like folders: the home keeps its directory while the sharer's
      // display name is unchanged; a fresh, different name re-derives it.
      const fresh = sharerDisplayName(zone);
      const renamed = previousHome !== undefined && fresh !== undefined && fresh !== previousHome.name;
      const name = renamed ? (fresh as string) : (previousHome?.name ?? fresh ?? zone.ownerRecordName);
      const candidate = !renamed && previousHome !== undefined ? previousHome.dirName : sanitizeFolderDirName(name);
      const dirName = claimTopLevelName(candidate, topLevelClaimed);
      sharerHomeDirs.set(zone.ownerRecordName, dirName);
      stateSharerHomes[zone.ownerRecordName] = { name, dirName };
      allDirs.push(dirName);
    }
  }

  // Each shared zone's folders form their own tree under the sharer's home.
  for (const zone of orderedZones) {
    const homeDir = sharerHomeDirs.get(zone.ownerRecordName) as string;
    const zoneFolders = mergeFolderInfos(
      Object.entries(previous?.folders ?? {})
        .filter(([, entry]) => entry.sharedZoneOwner === zone.ownerRecordName)
        .map(([recordName, entry]) => ({
          recordName,
          title: entry.name,
          parentRecordName: entry.parentRecordName,
          permission: entry.permission,
        })),
      zone.records,
    );
    const zoneTree = buildFolderTree(zoneFolders, preferredDirNames);

    // This account's permission per share record this run re-sent. A folder
    // resolves its permission freshest-first: this run's share record (via
    // the folder's record-level `share` reference), else what previous state
    // knew (an incremental pull won't re-send an unchanged share record),
    // else the parent folder's - nested folders belong to the shared root's
    // share. Still-undefined means "unknown"; push then attempts the write
    // and lets the server enforce the truth.
    const sharePermissions = new Map<string, string>();
    for (const record of zone.records) {
      if (record.recordType === "cloudkit.share" && record.deleted !== true && record.currentUserPermission !== undefined) {
        sharePermissions.set(record.recordName, record.currentUserPermission);
      }
    }
    const previousPermission = (recordName: string): string | undefined => {
      const entry = previous?.folders?.[recordName];
      return entry?.sharedZoneOwner === zone.ownerRecordName ? entry.permission : undefined;
    };
    const visit = (node: FolderTreeNode, inheritedPermission: string | undefined): void => {
      const permission =
        (node.shareRecordName !== undefined ? sharePermissions.get(node.shareRecordName) : undefined) ??
        previousPermission(node.recordName) ??
        inheritedPermission;
      const dirPath = `${homeDir}/${node.dirPath}`;
      folderDirs.set(node.recordName, dirPath);
      stateFolders[node.recordName] = {
        name: node.title,
        parentRecordName: node.parentRecordName,
        dirName: node.dirName,
        sharedZoneOwner: zone.ownerRecordName,
        permission,
      };
      allDirs.push(dirPath);
      for (const child of node.children) {
        visit(child, permission);
      }
    };
    for (const root of zoneTree.roots) {
      visit(root, undefined);
    }
  }

  return { folderDirs, sharerHomeDirs, stateFolders, stateSharerHomes, allDirs };
}

/** Where a note's file lives. `folderRecordName` is set only when the
 * note's Folder reference resolves to a folder this vault mirrors - an own
 * folder, or a shared folder in the note's own zone. An individually-shared
 * note's reference points into the sharer's unreadable private tree, so it
 * lands loose in the sharer's home with no folder membership. */
export interface NotePlacement {
  dir: string;
  folderRecordName?: string | undefined;
}

export function placeNote(
  layout: VaultLayout,
  record: CloudKitRecord,
  sharedZoneOwner: string | undefined,
): NotePlacement {
  const folderValue = record.fields.Folder?.value;
  const ref =
    typeof folderValue === "object" && folderValue !== null
      ? (folderValue as { recordName?: unknown }).recordName
      : undefined;
  const folderRecordName = typeof ref === "string" ? ref : undefined;

  if (sharedZoneOwner === undefined) {
    const dir = folderRecordName !== undefined ? layout.folderDirs.get(folderRecordName) : undefined;
    if (dir !== undefined) {
      return { dir, folderRecordName };
    }
    // A reference we can't resolve (or none at all) falls back to the
    // default folder's directory - every own note belongs somewhere.
    return { dir: layout.folderDirs.get(DEFAULT_FOLDER_RECORD_NAME) ?? "", folderRecordName: undefined };
  }

  const sharedDir = folderRecordName !== undefined ? layout.folderDirs.get(folderRecordName) : undefined;
  if (sharedDir !== undefined && layout.stateFolders[folderRecordName as string]?.sharedZoneOwner === sharedZoneOwner) {
    return { dir: sharedDir, folderRecordName };
  }
  return { dir: layout.sharerHomeDirs.get(sharedZoneOwner) ?? "", folderRecordName: undefined };
}

/** The vault-root-relative directory a tracked note actually sits in today,
 * from its state entry - where its attachments belong. POSIX form; "" for
 * the vault root. */
export function noteDirOf(stateFile: string): string {
  const dir = path.posix.dirname(stateFile);
  return dir === "." ? "" : dir;
}

/**
 * Where a *tracked* note should sit under the current layout, from its
 * state entry - `placeNote`'s twin for notes the server didn't re-send this
 * run. Returns undefined for "leave it where it is" (a shared note whose
 * zone has no home this run - vanished zones are handled separately).
 */
export function expectedNoteDir(layout: VaultLayout, entry: Pick<CloneStateNoteEntry, "folderRecordName" | "sharedZoneOwner">): string | undefined {
  if (entry.sharedZoneOwner === undefined) {
    const dir = entry.folderRecordName !== undefined ? layout.folderDirs.get(entry.folderRecordName) : undefined;
    return dir ?? layout.folderDirs.get(DEFAULT_FOLDER_RECORD_NAME) ?? "";
  }
  if (entry.folderRecordName !== undefined) {
    const dir = layout.folderDirs.get(entry.folderRecordName);
    if (dir !== undefined && layout.stateFolders[entry.folderRecordName]?.sharedZoneOwner === entry.sharedZoneOwner) {
      return dir;
    }
  }
  return layout.sharerHomeDirs.get(entry.sharedZoneOwner);
}

/** What a directory path in the vault corresponds to, per the state maps. */
export interface StateDirInfo {
  kind: "folder" | "sharerHome";
  /** Set for kind "folder". */
  folderRecordName?: string | undefined;
  /** Set for a shared folder or a sharer home. */
  sharedZoneOwner?: string | undefined;
  /** Shared folders only: this account's permission on the folder's share,
   * when known - see CloneStateFolderEntry.permission. */
  permission?: string | undefined;
}

/**
 * Reconstructs the directory map the carried state implies (dirPath →
 * what's there), without needing this run's records - the index `push`/
 * `status` classify local directories against, and the source of the
 * previous layout's paths for pull's stale-directory sweep. Best-effort:
 * unknown parents resolve the way buildFolderTree promoted them (to the
 * root of their namespace).
 */
export function stateDirIndex(previous: Pick<CloneState, "folders" | "sharerHomes">): Map<string, StateDirInfo> {
  const folders = previous.folders ?? {};
  const memo = new Map<string, string | undefined>();

  const resolve = (recordName: string, seen: Set<string>): string | undefined => {
    if (memo.has(recordName)) {
      return memo.get(recordName);
    }
    const entry = folders[recordName];
    if (!entry || seen.has(recordName)) {
      return undefined;
    }
    seen.add(recordName);
    const homePrefix =
      entry.sharedZoneOwner !== undefined ? previous.sharerHomes?.[entry.sharedZoneOwner]?.dirName : undefined;
    if (entry.sharedZoneOwner !== undefined && homePrefix === undefined) {
      memo.set(recordName, undefined);
      return undefined;
    }

    let dir: string;
    const parent = entry.parentRecordName !== undefined ? resolve(entry.parentRecordName, seen) : undefined;
    if (parent !== undefined) {
      dir = `${parent}/${entry.dirName}`;
    } else {
      dir = homePrefix !== undefined ? `${homePrefix}/${entry.dirName}` : entry.dirName;
    }
    memo.set(recordName, dir);
    return dir;
  };

  const index = new Map<string, StateDirInfo>();
  for (const [owner, home] of Object.entries(previous.sharerHomes ?? {})) {
    index.set(home.dirName, { kind: "sharerHome", sharedZoneOwner: owner });
  }
  for (const [recordName, entry] of Object.entries(folders)) {
    const dir = resolve(recordName, new Set());
    if (dir !== undefined) {
      index.set(dir, {
        kind: "folder",
        folderRecordName: recordName,
        sharedZoneOwner: entry.sharedZoneOwner,
        permission: entry.permission,
      });
    }
  }
  return index;
}

/** Every directory path the previous layout implied - see stateDirIndex. */
export function previousLayoutDirs(previous: Pick<CloneState, "folders" | "sharerHomes">): string[] {
  return [...stateDirIndex(previous).keys()];
}

/** Overlays fresh Folder records onto carried-forward FolderInfos: fresh
 * decodes win, tombstoned records drop out. */
function mergeFolderInfos(carried: FolderInfo[], records: readonly CloudKitRecord[]): FolderInfo[] {
  const merged = new Map<string, FolderInfo>(carried.map((info) => [info.recordName, info]));
  for (const record of records) {
    if (record.recordType !== "Folder") {
      continue;
    }
    if (record.deleted === true) {
      merged.delete(record.recordName);
      continue;
    }
    const decoded = decodeFolderRecord(record);
    if (decoded) {
      merged.set(decoded.recordName, decoded);
    }
  }
  return [...merged.values()];
}

/** The sharer's display name, from the OWNER participant of any share
 * record in the zone: full name, else email, else phone. */
export function sharerDisplayName(zone: SharedZoneRecords): string | undefined {
  for (const record of zone.records) {
    if (record.recordType !== "cloudkit.share") {
      continue;
    }
    const owner = record.participants?.find((participant: ShareParticipant) => participant.type === "OWNER");
    if (!owner) {
      continue;
    }
    const fullName = [owner.givenName, owner.familyName].filter((part) => part !== undefined && part !== "").join(" ");
    const name = fullName || owner.emailAddress || owner.phoneNumber;
    if (name) {
      return name;
    }
  }
  return undefined;
}

function claimTopLevelName(candidate: string, claimedLower: Set<string>): string {
  let name = candidate;
  let n = 2;
  while (claimedLower.has(name.toLowerCase())) {
    name = `${candidate} ${n}`;
    n += 1;
  }
  claimedLower.add(name.toLowerCase());
  return name;
}
