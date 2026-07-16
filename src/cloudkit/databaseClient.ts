import type { IcloudSession } from "../session.js";
import { loggedFetch } from "../debugLog.js";
import { CloudKitRequestFailedError } from "../errors.js";

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
  /** The record's parent reference (for notes: the containing folder).
   * Echoed back on updates the way the web client does. */
  parentRecordName?: string | undefined;
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
    throw new CloudKitRequestFailedError(`${operation} request failed (${database} db): HTTP ${response.status}`);
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
  onPage?: (pageRecordCount: number) => void,
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
    const pageRecords = zone.records ?? [];

    records.push(...pageRecords);
    syncToken = zone.syncToken ?? syncToken;
    moreComing = zone.moreComing === true;
    onPage?.(pageRecords.length);
  }

  return { records, syncToken };
}

/** Fetches records in the account's own (private-database) Notes zone. */
export async function fetchAllNoteRecords(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  sinceSyncToken?: string,
  onPage?: (pageRecordCount: number) => void,
): Promise<ZoneChangesResult> {
  return fetchZoneNoteRecords(session, ckDatabaseHost, dsid, "private", { zoneName: "Notes" }, sinceSyncToken, onPage);
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
  onPage?: (pageRecordCount: number) => void,
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
      onPage,
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

/**
 * Downloads an attachment's raw bytes from its signed `cvws.icloud-content.com`
 * URL (the `downloadURL` on a Media record's `Asset` field). These URLs are
 * plain, unauthenticated GETs - no cookie or session header, just the
 * signature baked into the query string - confirmed against real captures of
 * both an audio and an image attachment (dev notes, 2026-07-13/14). They do
 * carry an expiry (`e=` query param), so a stored URL can go stale; re-`lookup`
 * the owning record to get a fresh one rather than retrying the same URL.
 */
export async function fetchAssetBytes(downloadURL: string): Promise<Buffer> {
  const response = await loggedFetch("fetchAssetBytes", downloadURL, {
    method: "GET",
    headers: { Origin: "https://www.icloud.com", Referer: "https://www.icloud.com/" },
  });
  if (!response.ok) {
    throw new CloudKitRequestFailedError(`Attachment download failed: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export interface NoteUpdate {
  recordName: string;
  /** Optimistic-concurrency token: the server rejects the update if the
   * record has moved past this tag - exactly the "don't clobber a change
   * you haven't seen" primitive push is built on. */
  recordChangeTag: string;
  fields: Record<string, { value: unknown }>;
  parentRecordName?: string | undefined;
}

export type NoteUpdateResult =
  | { ok: true; record: CloudKitRecord }
  | { ok: false; serverErrorCode: string; reason: string | undefined };

/**
 * Updates one note via `records/modify`, using the same single-operation
 * `update` shape the web client sends. Per-record failures (notably a
 * changeTag conflict) come back inside an HTTP 200 as `serverErrorCode` on
 * the record entry; those are returned as a typed refusal rather than
 * thrown, since "someone else edited this note" is an expected outcome the
 * caller wants to report per-note.
 */
export async function updateNoteRecord(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  zoneID: CloudKitZoneID,
  update: NoteUpdate,
): Promise<NoteUpdateResult> {
  const [result] = await updateRecords(session, ckDatabaseHost, dsid, zoneID, [{ ...update, recordType: "Note" }]);
  if (!result) {
    throw new Error("Unexpected response shape from records/modify (missing records array)");
  }
  return result;
}

export function parseNoteUpdateResponse(body: unknown): NoteUpdateResult {
  if (!isRecord(body) || !Array.isArray(body.records) || body.records.length === 0) {
    throw new Error("Unexpected response shape from records/modify (missing records array)");
  }
  const entry: unknown = body.records[0];
  if (!isRecord(entry)) {
    throw new Error("Unexpected response shape from records/modify (record entry is not an object)");
  }
  if (typeof entry.serverErrorCode === "string") {
    return {
      ok: false,
      serverErrorCode: entry.serverErrorCode,
      reason: typeof entry.reason === "string" ? entry.reason : undefined,
    };
  }
  return { ok: true, record: parseRecord(entry) };
}

export type NoteDeleteResult =
  | { ok: true }
  | { ok: false; serverErrorCode: string; reason: string | undefined };

/**
 * Deletes one note via `records/modify`, using the same `forceDelete`
 * operation type the real web/mobile clients use (confirmed against a
 * working reference implementation - see the "Delete a note from iCloud"
 * investigation in the project notes). Per Apple's own client behavior this
 * is a server-managed soft delete (the note lands in "Recently Deleted"),
 * not a hard wipe.
 */
export async function deleteNoteRecord(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  zoneID: CloudKitZoneID,
  recordName: string,
  recordChangeTag: string,
): Promise<NoteDeleteResult> {
  const body = await postDatabase(
    "deleteNoteRecord:records/modify",
    session,
    ckDatabaseHost,
    dsid,
    "private",
    "records/modify",
    {
      operations: [
        { operationType: "forceDelete", record: { recordName, recordType: "Note", recordChangeTag } },
      ],
      zoneID,
    },
  );
  return parseNoteDeleteResponse(body);
}

/**
 * A successful `forceDelete` response record entry looks nothing like an
 * `update` one - confirmed live 2026-07-16: `{"recordName": "...",
 * "deleted": true}`, with no `recordType`/`fields`/`recordChangeTag` at
 * all. `parseNoteUpdateResponse`'s `parseRecord` call requires those, so it
 * throws on a genuinely successful delete - this is a dedicated parser
 * instead of a shared one, since there's no full record to hand back to a
 * delete caller anyway (there's nothing left to describe).
 */
export function parseNoteDeleteResponse(body: unknown): NoteDeleteResult {
  if (!isRecord(body) || !Array.isArray(body.records) || body.records.length === 0) {
    throw new Error("Unexpected response shape from records/modify (missing records array)");
  }
  const entry: unknown = body.records[0];
  if (!isRecord(entry)) {
    throw new Error("Unexpected response shape from records/modify (record entry is not an object)");
  }
  if (typeof entry.serverErrorCode === "string") {
    return {
      ok: false,
      serverErrorCode: entry.serverErrorCode,
      reason: typeof entry.reason === "string" ? entry.reason : undefined,
    };
  }
  if (typeof entry.recordName !== "string") {
    throw new Error("Unexpected response shape from records/modify (record entry has no recordName)");
  }
  return { ok: true };
}

export interface RecordUpdate {
  recordName: string;
  /** Unlike the single-record `updateNoteRecord`, not hardcoded to "Note" -
   * a table write needs to update a Note record and an Attachment record
   * (the table's own `MergeableDataEncrypted`) atomically in one call. */
  recordType: string;
  /** Optimistic-concurrency token; see `NoteUpdate`. */
  recordChangeTag: string;
  fields: Record<string, { value: unknown }>;
  parentRecordName?: string | undefined;
}

export type RecordUpdateResult = NoteUpdateResult;

/**
 * Updates any number of records in one zone via a single `records/modify`
 * call with one `update` operation per record - the real CloudKit endpoint
 * already accepts multiple operations atomically per zone; `updateNoteRecord`
 * used to hardcode a single-element operations array as a self-imposed
 * limitation, not a server one. Results come back in the same order as
 * `updates`, each independently `ok`/refused (a changeTag conflict on one
 * record doesn't fail the others) - though a caller relying on the *write*
 * being atomic (e.g. a note's text and its table changing together) should
 * still treat any non-`ok` result as "nothing in this batch should be
 * trusted as applied", since CloudKit only guarantees atomicity of the
 * write itself, not of how per-record failures are reported back.
 */
export async function updateRecords(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  zoneID: CloudKitZoneID,
  updates: RecordUpdate[],
): Promise<RecordUpdateResult[]> {
  const operations = updates.map((update) => {
    const record: Record<string, unknown> = {
      recordName: update.recordName,
      recordType: update.recordType,
      recordChangeTag: update.recordChangeTag,
      fields: update.fields,
    };
    if (update.parentRecordName !== undefined) {
      record.parent = { recordName: update.parentRecordName };
    }
    return { operationType: "update", record };
  });

  const body = await postDatabase(
    "updateRecords:records/modify",
    session,
    ckDatabaseHost,
    dsid,
    "private",
    "records/modify",
    { operations, zoneID },
  );
  return parseRecordUpdateResponse(body);
}

export function parseRecordUpdateResponse(body: unknown): RecordUpdateResult[] {
  if (!isRecord(body) || !Array.isArray(body.records)) {
    throw new Error("Unexpected response shape from records/modify (missing records array)");
  }
  return body.records.map((entry: unknown) => {
    if (!isRecord(entry)) {
      throw new Error("Unexpected response shape from records/modify (record entry is not an object)");
    }
    if (typeof entry.serverErrorCode === "string") {
      return {
        ok: false,
        serverErrorCode: entry.serverErrorCode,
        reason: typeof entry.reason === "string" ? entry.reason : undefined,
      };
    }
    return { ok: true, record: parseRecord(entry) };
  });
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
    throw new CloudKitRequestFailedError(`changes/zone failed for a zone: ${zone.serverErrorCode} (${reason})`);
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

  const parent = isRecord(value.parent) && typeof value.parent.recordName === "string" ? value.parent.recordName : undefined;
  return {
    recordName: value.recordName,
    recordType: value.recordType,
    fields,
    recordChangeTag: typeof value.recordChangeTag === "string" ? value.recordChangeTag : undefined,
    deleted: typeof value.deleted === "boolean" ? value.deleted : undefined,
    parentRecordName: parent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
