import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { TRASH_FOLDER_RECORD_NAME } from "./encodeNoteRecord.js";

/** The account's default "Notes" folder - a real Folder record like any
 * other, just with a well-known name (confirmed live 2026-07-16, title
 * "Notes"). It becomes an ordinary directory in the clone. */
export const DEFAULT_FOLDER_RECORD_NAME = "DefaultFolder-CloudKit";

/** Directory names the clone reserves for itself at the top level. */
export const RESERVED_TOP_LEVEL_DIR_NAMES: readonly string[] = [".icloud-notes-sync"];

/** Directory names the clone reserves inside *every* folder directory:
 * attachments live per-folder (decided 2026-07-16, see the folders doc), so
 * a real Notes folder titled "attachments" uniquifies to "attachments 2/"
 * wherever it sits. */
export const RESERVED_SIBLING_DIR_NAMES: readonly string[] = ["attachments"];

/** A Folder record as decoded from the sync stream - the raw material for
 * buildFolderTree. */
export interface FolderInfo {
  recordName: string;
  /** Decoded title ("Notes", "Recipes", ...). Empty when the record has no
   * decodable TitleEncrypted; sanitizeFolderDirName supplies the fallback. */
  title: string;
  /**
   * The parent Folder's recordName for a nested folder; undefined for a
   * top-level one. Confirmed live 2026-07-16 (see the folders doc): a
   * nested folder carries an explicit `ParentFolder` REFERENCE field and
   * the same value in CloudKit's record-level parent; a top-level folder
   * has neither.
   */
  parentRecordName?: string | undefined;
}

export interface FolderTreeNode extends FolderInfo {
  /** Directory name on disk: sanitized title, uniquified among siblings. */
  dirName: string;
  /** Vault-root-relative POSIX path ("Recipes/Desserts"). */
  dirPath: string;
  children: FolderTreeNode[];
}

export interface FolderTree {
  roots: FolderTreeNode[];
  byRecordName: Map<string, FolderTreeNode>;
}

/**
 * Decodes one raw CloudKit record into a FolderInfo, or undefined for
 * records that don't participate in the folder tree: non-Folder types and
 * the Trash folder (trashed notes are excluded from the clone entirely).
 */
export function decodeFolderRecord(record: CloudKitRecord): FolderInfo | undefined {
  if (record.recordType !== "Folder" || record.recordName === TRASH_FOLDER_RECORD_NAME) {
    return undefined;
  }
  const titleField = record.fields.TitleEncrypted;
  const title =
    titleField && typeof titleField.value === "string"
      ? Buffer.from(titleField.value, "base64").toString("utf-8")
      : "";
  return {
    recordName: record.recordName,
    title,
    parentRecordName: parentFolderReference(record) ?? record.parentRecordName,
  };
}

/** The explicit `ParentFolder` REFERENCE field a nested folder carries (its
 * value duplicates the record-level parent, but the field is the
 * Apple-semantic source, so it wins). */
function parentFolderReference(record: CloudKitRecord): string | undefined {
  const value = record.fields.ParentFolder?.value;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const recordName = (value as Record<string, unknown>).recordName;
  return typeof recordName === "string" ? recordName : undefined;
}

/** Same character rules as note file names, minus the extension; folders
 * with no usable title become "Untitled Folder". */
export function sanitizeFolderDirName(title: string): string {
  const firstLine = title.split("\n")[0]?.trim() ?? "";
  const slug = firstLine
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    // A trailing dot or space is invalid on Windows and confusing anywhere.
    .replace(/[. ]+$/, "");
  return slug.length > 0 ? slug : "Untitled Folder";
}

/**
 * Builds the on-disk directory tree from decoded Folder records.
 *
 * Sibling directory names are uniquified case-insensitively (two sibling
 * folders "recipes" and "Recipes" must not collide on a case-insensitive
 * filesystem), and the reserved top-level names are pre-claimed so no root
 * folder can shadow them.
 *
 * `preferredDirNames` (folder recordName → dirName, from a previous sync's
 * state) keeps directory names stable across pulls: a folder keeps its
 * existing directory as long as that name is still available among its
 * siblings, even when a newly-appeared sibling would otherwise have claimed
 * it first. Folders with a preferred name are assigned before those
 * without.
 *
 * Defensive shape handling, since the server owns this data: a folder whose
 * parent isn't in the input, or whose ancestry cycles, is promoted to a
 * root rather than dropped - every folder always lands somewhere visible.
 */
export function buildFolderTree(folders: readonly FolderInfo[], preferredDirNames?: ReadonlyMap<string, string>): FolderTree {
  const byRecordName = new Map<string, FolderTreeNode>();
  for (const folder of folders) {
    byRecordName.set(folder.recordName, { ...folder, dirName: "", dirPath: "", children: [] });
  }

  // Link children; a missing parent means "treat as root".
  const roots: FolderTreeNode[] = [];
  for (const node of byRecordName.values()) {
    const parent = node.parentRecordName !== undefined ? byRecordName.get(node.parentRecordName) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Promote cycle members (unreachable from any root) until everything is
  // reachable. Deterministic: always promote the smallest recordName first.
  const reachable = collectReachable(roots);
  const unreachable = [...byRecordName.values()].filter((node) => !reachable.has(node)).sort(byRecordNameOrder);
  for (const node of unreachable) {
    if (reachable.has(node)) {
      continue;
    }
    const parent = node.parentRecordName !== undefined ? byRecordName.get(node.parentRecordName) : undefined;
    if (parent) {
      parent.children.splice(parent.children.indexOf(node), 1);
    }
    roots.push(node);
    for (const reached of collectReachable([node])) {
      reachable.add(reached);
    }
  }

  assignDirNames(roots, reservedNames(true), "", preferredDirNames);
  return { roots, byRecordName };
}

function collectReachable(roots: readonly FolderTreeNode[]): Set<FolderTreeNode> {
  const reachable = new Set<FolderTreeNode>();
  const queue = [...roots];
  while (queue.length > 0) {
    const node = queue.pop() as FolderTreeNode;
    if (reachable.has(node)) {
      continue;
    }
    reachable.add(node);
    queue.push(...node.children);
  }
  return reachable;
}

function byRecordNameOrder(a: FolderTreeNode, b: FolderTreeNode): number {
  return a.recordName < b.recordName ? -1 : a.recordName > b.recordName ? 1 : 0;
}

function reservedNames(topLevel: boolean): Set<string> {
  const names = topLevel ? [...RESERVED_SIBLING_DIR_NAMES, ...RESERVED_TOP_LEVEL_DIR_NAMES] : RESERVED_SIBLING_DIR_NAMES;
  return new Set(names.map((name) => name.toLowerCase()));
}

function assignDirNames(
  siblings: FolderTreeNode[],
  claimedLower: Set<string>,
  parentPath: string,
  preferredDirNames: ReadonlyMap<string, string> | undefined,
): void {
  // Two passes so a folder that already has a directory on disk keeps it:
  // preferred names first, then fresh assignments around them. Within each
  // pass the order is deterministic (title, then recordName).
  const ordered = [...siblings].sort((a, b) => a.title.localeCompare(b.title) || byRecordNameOrder(a, b));
  const withPreference = ordered.filter((node) => preferredDirNames?.has(node.recordName));
  const withoutPreference = ordered.filter((node) => !preferredDirNames?.has(node.recordName));

  for (const node of withPreference) {
    const preferred = preferredDirNames?.get(node.recordName) as string;
    const name = claimedLower.has(preferred.toLowerCase())
      ? nextFreeName(sanitizeFolderDirName(node.title), claimedLower)
      : preferred;
    claim(node, name, claimedLower, parentPath);
  }
  for (const node of withoutPreference) {
    claim(node, nextFreeName(sanitizeFolderDirName(node.title), claimedLower), claimedLower, parentPath);
  }
  for (const node of ordered) {
    assignDirNames(node.children, reservedNames(false), node.dirPath, preferredDirNames);
  }
}

/** Finder-style " 2", " 3", ... suffixing, like uniqueFileName but without
 * its extension splitting (directory names have no extension). */
function nextFreeName(candidate: string, claimedLower: ReadonlySet<string>): string {
  if (!claimedLower.has(candidate.toLowerCase())) {
    return candidate;
  }
  let n = 2;
  while (claimedLower.has(`${candidate.toLowerCase()} ${n}`)) {
    n += 1;
  }
  return `${candidate} ${n}`;
}

function claim(node: FolderTreeNode, dirName: string, claimedLower: Set<string>, parentPath: string): void {
  node.dirName = dirName;
  node.dirPath = parentPath === "" ? dirName : `${parentPath}/${dirName}`;
  claimedLower.add(dirName.toLowerCase());
}
