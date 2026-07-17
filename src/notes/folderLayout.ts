import path from "node:path";
import type { CloudKitRecord, ShareParticipant } from "../cloudkit/databaseClient.js";
import type { CloneState, CloneStateFolderEntry, CloneStateSharerHomeEntry } from "./cloneState.js";
import {
  buildFolderTree,
  decodeFolderRecord,
  DEFAULT_FOLDER_RECORD_NAME,
  RESERVED_SIBLING_DIR_NAMES,
  RESERVED_TOP_LEVEL_DIR_NAMES,
  sanitizeFolderDirName,
  type FolderInfo,
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
  const preferredDirNames = new Map<string, string>(
    Object.entries(previous?.folders ?? {}).map(([recordName, entry]) => [recordName, entry.dirName]),
  );

  // Own folders: previous state as the base, overlaid with this run's
  // records (which may add, rename, re-parent, or tombstone).
  const ownFolders = mergeFolderInfos(
    Object.entries(previous?.folders ?? {})
      .filter(([, entry]) => entry.sharedZoneOwner === undefined)
      .map(([recordName, entry]) => ({ recordName, title: entry.name, parentRecordName: entry.parentRecordName })),
    privateRecords,
  );

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
      const name = previousHome?.name ?? sharerDisplayName(zone) ?? zone.ownerRecordName;
      const candidate = previousHome?.dirName ?? sanitizeFolderDirName(name);
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
        .map(([recordName, entry]) => ({ recordName, title: entry.name, parentRecordName: entry.parentRecordName })),
      zone.records,
    );
    const zoneTree = buildFolderTree(zoneFolders, preferredDirNames);
    for (const node of zoneTree.byRecordName.values()) {
      const dirPath = `${homeDir}/${node.dirPath}`;
      folderDirs.set(node.recordName, dirPath);
      stateFolders[node.recordName] = {
        name: node.title,
        parentRecordName: node.parentRecordName,
        dirName: node.dirName,
        sharedZoneOwner: zone.ownerRecordName,
      };
      allDirs.push(dirPath);
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
