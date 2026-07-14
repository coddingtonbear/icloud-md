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

/** Which of the container's databases to talk to. Notes shared *with* this
 * account live in zones of the `shared` database, owned by other users. */
export type CloudKitDatabase = "private" | "shared";

export interface CloudKitZoneID {
  zoneName: string;
  ownerRecordName?: string | undefined;
}

/** One shared zone's worth of note records, tagged with its owner so state
 * tracking can tell which sharer's zone each note came from. */
export interface SharedZoneChanges {
  zoneID: CloudKitZoneID;
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

async function postDatabase(
  label: string,
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  database: CloudKitDatabase,
  operation: string,
  body: unknown,
): Promise<unknown> {
  const params = new URLSearchParams({
    ckjsBuildVersion: CKJS_BUILD_VERSION,
    ckjsVersion: CKJS_VERSION,
    clientId: session.clientId,
    clientBuildNumber: session.clientBuildNumber,
    clientMasteringNumber: session.clientMasteringNumber,
    dsid,
  });

  const response = await loggedFetch(
    label,
    `${ckDatabaseHost}/database/1/com.apple.notes/production/${database}/${operation}?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Cookie: session.cookie,
        "Content-Type": "application/json",
        Origin: "https://www.icloud.com",
        Referer: "https://www.icloud.com/",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    throw new Error(`${operation} request failed (${database} db): HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Fetches records in one Notes zone by paging through `changes/zone` until
 * `moreComing` is false, following the same `syncToken`-based
 * incremental-sync model the web client uses. Pass `sinceSyncToken` (from a
 * prior call's result) to fetch only what changed since then; omit it for a
 * full initial fetch. Returns the new syncToken so a future call can resume
 * from here.
 */
export async function fetchZoneNoteRecords(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  database: CloudKitDatabase,
  zoneID: CloudKitZoneID,
  sinceSyncToken?: string,
): Promise<ZoneChangesResult> {
  const records: CloudKitRecord[] = [];
  let syncToken: string | undefined = sinceSyncToken;
  let moreComing = true;

  while (moreComing) {
    const zoneRequest: Record<string, unknown> = {
      zoneID,
      desiredKeys: NOTE_DESIRED_KEYS,
      desiredRecordTypes: NOTE_DESIRED_RECORD_TYPES,
    };
    // The shared database rejects `reverse` outright ("Reverse sync of share
    // db is unsupported", BAD_REQUEST) - only send it where the web client
    // does, on private-zone fetches.
    if (database === "private") {
      zoneRequest.reverse = true;
    }
    if (syncToken) {
      zoneRequest.syncToken = syncToken;
    }

    const body = await postDatabase(
      "fetchZoneNoteRecords:changes/zone",
      session,
      ckDatabaseHost,
      dsid,
      database,
      "changes/zone",
      { zones: [zoneRequest] },
    );
    const zone = firstZone(body);

    records.push(...(zone.records ?? []));
    syncToken = zone.syncToken ?? syncToken;
    moreComing = zone.moreComing === true;
  }

  return { records, syncToken };
}

/** Fetches records in the account's own (private-database) Notes zone. */
export async function fetchAllNoteRecords(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  sinceSyncToken?: string,
): Promise<ZoneChangesResult> {
  return fetchZoneNoteRecords(session, ckDatabaseHost, dsid, "private", { zoneName: "Notes" }, sinceSyncToken);
}

/**
 * Lists the zones of the shared database - one per user who has shared
 * note(s) with this account (`zoneName` is "Notes", `ownerRecordName`
 * identifies the sharer). Mirrors the web client's `shared/changes/database`
 * call, which it issues with an empty body on every load rather than a
 * stored database-level syncToken; zone-level tokens carry the actual
 * incremental state.
 */
export async function fetchSharedZoneIds(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
): Promise<CloudKitZoneID[]> {
  const body = await postDatabase(
    "fetchSharedZoneIds:changes/database",
    session,
    ckDatabaseHost,
    dsid,
    "shared",
    "changes/database",
    {},
  );
  return parseSharedZoneList(body);
}

export function parseSharedZoneList(body: unknown): CloudKitZoneID[] {
  if (!isRecord(body) || !Array.isArray(body.zones)) {
    throw new Error("Unexpected response shape from shared changes/database (missing zones array)");
  }
  return body.zones.map((zone: unknown) => {
    if (!isRecord(zone) || !isRecord(zone.zoneID) || typeof zone.zoneID.zoneName !== "string") {
      throw new Error("Unexpected zone shape in shared changes/database response");
    }
    return {
      zoneName: zone.zoneID.zoneName,
      ownerRecordName:
        typeof zone.zoneID.ownerRecordName === "string" ? zone.zoneID.ownerRecordName : undefined,
    };
  });
}

/**
 * Fetches full records by name from one zone via `records/lookup`. The
 * shared database's `changes/zone` listing doesn't return note bodies
 * (`TextDataEncrypted`) even when asked - the web client fetches those
 * per-note through this same lookup call.
 */
export async function lookupRecords(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  database: CloudKitDatabase,
  zoneID: CloudKitZoneID,
  recordNames: string[],
): Promise<CloudKitRecord[]> {
  if (recordNames.length === 0) {
    return [];
  }
  const body = await postDatabase(
    "lookupRecords:records/lookup",
    session,
    ckDatabaseHost,
    dsid,
    database,
    "records/lookup",
    { records: recordNames.map((recordName) => ({ recordName })), zoneID },
  );

  if (!isRecord(body) || !Array.isArray(body.records)) {
    throw new Error("Unexpected response shape from records/lookup (missing records array)");
  }
  // Per-record errors (e.g. NOT_FOUND for a record deleted since it was
  // listed) come back as entries without `fields`/`recordType` - skip those
  // rather than failing the whole lookup; the caller's record keeps whatever
  // the zone listing returned and gets classified from that.
  return body.records
    .filter((entry: unknown) => isRecord(entry) && typeof entry.recordType === "string" && isRecord(entry.fields))
    .map(parseRecord);
}

/**
 * Fetches every shared zone's note records, filling in note bodies (via
 * `records/lookup`) for live Note records the zone listing returned without
 * `TextDataEncrypted`. `sinceSyncTokens` is keyed by the zone owner's
 * recordName; zones without an entry are fetched from scratch.
 */
export async function fetchSharedNoteRecords(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  sinceSyncTokens: Record<string, string> = {},
): Promise<SharedZoneChanges[]> {
  const zoneIds = await fetchSharedZoneIds(session, ckDatabaseHost, dsid);
  const results: SharedZoneChanges[] = [];

  for (const zoneID of zoneIds) {
    const owner = zoneID.ownerRecordName;
    const sinceSyncToken = owner ? sinceSyncTokens[owner] : undefined;
    const { records, syncToken } = await fetchZoneNoteRecords(
      session,
      ckDatabaseHost,
      dsid,
      "shared",
      zoneID,
      sinceSyncToken,
    );

    const missingBody = records.filter(needsBodyLookup);
    if (missingBody.length > 0) {
      const lookedUp = await lookupRecords(
        session,
        ckDatabaseHost,
        dsid,
        "shared",
        zoneID,
        missingBody.map((record) => record.recordName),
      );
      mergeLookedUpRecords(records, lookedUp);
    }

    results.push({ zoneID, records, syncToken });
  }

  return results;
}

function needsBodyLookup(record: CloudKitRecord): boolean {
  if (record.recordType !== "Note" || record.deleted === true) {
    return false;
  }
  return typeof record.fields.TextDataEncrypted?.value !== "string";
}

/** Replaces zone-listing records in place with their full looked-up versions. */
export function mergeLookedUpRecords(records: CloudKitRecord[], lookedUp: CloudKitRecord[]): void {
  const byName = new Map(lookedUp.map((record) => [record.recordName, record]));
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) {
      continue;
    }
    const full = byName.get(record.recordName);
    if (full) {
      records[i] = {
        ...full,
        // The lookup response omits recordChangeTag-independent metadata we
        // already have; keep the listing's changeTag if the lookup lacks one.
        recordChangeTag: full.recordChangeTag ?? record.recordChangeTag,
      };
    }
  }
}

interface ParsedZone {
  moreComing?: boolean | undefined;
  syncToken?: string | undefined;
  records?: CloudKitRecord[] | undefined;
}

export function firstZone(body: unknown): ParsedZone {
  if (!isRecord(body) || !Array.isArray(body.zones) || body.zones.length === 0) {
    throw new Error("Unexpected response shape from changes/zone (missing zones array)");
  }
  const zone: unknown = body.zones[0];
  if (!isRecord(zone)) {
    throw new Error("Unexpected response shape from changes/zone (zone entry is not an object)");
  }
  // Zone-level failures arrive inside an HTTP 200: the zone entry carries
  // serverErrorCode/reason instead of records. Treating that as "no records"
  // would make a broken fetch look like a clean empty sync.
  if (typeof zone.serverErrorCode === "string") {
    const reason = typeof zone.reason === "string" ? zone.reason : "no reason given";
    throw new Error(`changes/zone failed for a zone: ${zone.serverErrorCode} (${reason})`);
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
