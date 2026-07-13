import type { IcloudSession } from "../session.js";
import { loggedFetch } from "../debugLog.js";

export interface CloudKitFieldValue {
  value: unknown;
  type: string;
}

export interface CloudKitRecord {
  recordName: string;
  recordType: string;
  fields: Record<string, CloudKitFieldValue>;
  recordChangeTag?: string | undefined;
  deleted?: boolean | undefined;
}

export interface ZoneChangesResult {
  records: CloudKitRecord[];
  syncToken: string | undefined;
}

// Client version identifiers observed from a real www.icloud.com session (see
// projects/software/icloud-notes-sync.md dev notes). May need bumping over time.
const CKJS_BUILD_VERSION = "2310ProjectDev27";
const CKJS_VERSION = "2.6.4";

// Wider than we strictly need today; matches what the real web client requests so
// the server doesn't get an unfamiliar shape. Extra keys/types beyond what we
// read are harmless.
const NOTE_DESIRED_KEYS = [
  "TitleEncrypted",
  "SnippetEncrypted",
  "FirstAttachmentUTIEncrypted",
  "FirstAttachmentThumbnail",
  "FirstAttachmentThumbnailOrientation",
  "CreationDate",
  "ModificationDate",
  "Deleted",
  "Folders",
  "Folder",
  "Attachments",
  "ParentFolder",
  "Note",
  "LastViewedModificationDate",
  "MinimumSupportedNotesVersion",
  "DisplayTextEncrypted",
  "StandardizedContentEncrypted",
  "TokenContentIdentifierEncrypted",
  "AltTextEncrypted",
  "UTIEncrypted",
  "MergeableDataEncrypted",
  "IsPinned",
  "TextDataEncrypted",
];

const NOTE_DESIRED_RECORD_TYPES = [
  "AccountData",
  "Note",
  "SearchIndexes",
  "Folder",
  "PasswordProtectedNote",
  "User",
  "Users",
  "Note_UserSpecific",
  "PasswordProtectedNote_UserSpecific",
  "Folder_UserSpecific",
  "cloudkit.share",
  "Hashtag",
  "InlineAttachment",
];

/**
 * Fetches records in the private Notes zone by paging through `changes/zone`
 * until `moreComing` is false, following the same `syncToken`-based
 * incremental-sync model the web client uses. Pass `sinceSyncToken` (from a
 * prior call's result) to fetch only what changed since then; omit it for a
 * full initial fetch. Returns the new syncToken so a future call can resume
 * from here.
 */
export async function fetchAllNoteRecords(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  sinceSyncToken?: string,
): Promise<ZoneChangesResult> {
  const records: CloudKitRecord[] = [];
  let syncToken: string | undefined = sinceSyncToken;
  let moreComing = true;

  while (moreComing) {
    const zoneRequest: Record<string, unknown> = {
      zoneID: { zoneName: "Notes" },
      desiredKeys: NOTE_DESIRED_KEYS,
      desiredRecordTypes: NOTE_DESIRED_RECORD_TYPES,
      reverse: true,
    };
    if (syncToken) {
      zoneRequest.syncToken = syncToken;
    }

    const params = new URLSearchParams({
      ckjsBuildVersion: CKJS_BUILD_VERSION,
      ckjsVersion: CKJS_VERSION,
      clientId: session.clientId,
      clientBuildNumber: session.clientBuildNumber,
      clientMasteringNumber: session.clientMasteringNumber,
      dsid,
    });

    const response = await loggedFetch(
      "fetchAllNoteRecords:changes/zone",
      `${ckDatabaseHost}/database/1/com.apple.notes/production/private/changes/zone?${params.toString()}`,
      {
        method: "POST",
        headers: {
          Cookie: session.cookie,
          "Content-Type": "application/json",
          Origin: "https://www.icloud.com",
          Referer: "https://www.icloud.com/",
          Accept: "application/json",
        },
        body: JSON.stringify({ zones: [zoneRequest] }),
      },
    );

    if (!response.ok) {
      throw new Error(`changes/zone request failed: HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    const zone = firstZone(body);

    records.push(...(zone.records ?? []));
    syncToken = zone.syncToken ?? syncToken;
    moreComing = zone.moreComing === true;
  }

  return { records, syncToken };
}

interface ParsedZone {
  moreComing?: boolean | undefined;
  syncToken?: string | undefined;
  records?: CloudKitRecord[] | undefined;
}

function firstZone(body: unknown): ParsedZone {
  if (!isRecord(body) || !Array.isArray(body.zones) || body.zones.length === 0) {
    throw new Error("Unexpected response shape from changes/zone (missing zones array)");
  }
  const zone: unknown = body.zones[0];
  if (!isRecord(zone)) {
    throw new Error("Unexpected response shape from changes/zone (zone entry is not an object)");
  }

  const records = Array.isArray(zone.records) ? zone.records.map(parseRecord) : undefined;
  return {
    moreComing: typeof zone.moreComing === "boolean" ? zone.moreComing : undefined,
    syncToken: typeof zone.syncToken === "string" ? zone.syncToken : undefined,
    records,
  };
}

function parseRecord(value: unknown): CloudKitRecord {
  if (
    !isRecord(value) ||
    typeof value.recordName !== "string" ||
    typeof value.recordType !== "string" ||
    !isRecord(value.fields)
  ) {
    throw new Error("Unexpected record shape in changes/zone response");
  }

  const fields: Record<string, CloudKitFieldValue> = {};
  for (const [key, fieldValue] of Object.entries(value.fields)) {
    if (isRecord(fieldValue) && typeof fieldValue.type === "string") {
      fields[key] = { value: fieldValue.value, type: fieldValue.type };
    }
  }

  return {
    recordName: value.recordName,
    recordType: value.recordType,
    fields,
    recordChangeTag: typeof value.recordChangeTag === "string" ? value.recordChangeTag : undefined,
    deleted: typeof value.deleted === "boolean" ? value.deleted : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
