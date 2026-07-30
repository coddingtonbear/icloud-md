/**
 * Building the field set for a Folder record create.
 *
 * A Folder is the simplest record this tool writes. Dumped straight off the
 * account, a top-level folder created by Apple's own web client is, in full:
 *
 *   { recordType: "Folder",
 *     fields: { TitleEncrypted: { value: "<base64>", type: "ENCRYPTED_BYTES" } } }
 *
 * No ordering field, no parent, and - checked across the whole zone - no
 * `Folder_UserSpecific` companion record either. `ENCRYPTED_BYTES` is
 * encrypted server-side, so the client sends plain UTF-8 bytes base64'd,
 * exactly as note creates already do for their own `TitleEncrypted`
 * (verified 2026-07-30: the value decoded straight back to the folder's
 * name).
 *
 * A nested folder additionally carries an explicit `ParentFolder` reference
 * and the same value as the CloudKit record-level parent (documented from
 * the read side in `folderTree.ts`, confirmed live 2026-07-16).
 */

import { folderReference } from "./encodeNoteRecord.js";

export interface FolderCreateFields {
  fields: Record<string, { value: unknown }>;
  /** CloudKit record-level parent, mirroring `ParentFolder`; absent at top level. */
  parentRecordName?: string | undefined;
}

/**
 * Fields for creating a folder titled `title`, optionally nested inside
 * `parentRecordName`.
 */
export function buildFolderCreateFields(title: string, parentRecordName?: string | undefined): FolderCreateFields {
  const fields: Record<string, { value: unknown }> = {
    TitleEncrypted: { value: Buffer.from(title, "utf-8").toString("base64") },
  };
  if (parentRecordName === undefined) {
    return { fields };
  }
  fields.ParentFolder = { value: folderReference(parentRecordName) };
  return { fields, parentRecordName };
}
