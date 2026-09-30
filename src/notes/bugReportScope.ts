import type { DebugLogRecord } from "../debugLog.js";
import type { CloneState } from "./cloneState.js";
import { resolveTrackedNote } from "./trackedFile.js";

/**
 * The set of records a scoped bug report is allowed to mention. Built from
 * one or more tracked note files (`bug-report --note <file>`), and widened
 * to the attachment and table records those notes own - a table's bytes
 * live on a separate `Attachment` record, so a report about a garbled
 * table that only carried the Note record would be useless.
 *
 * Scoping exists because the default export is an all-or-nothing choice:
 * it carries the vault's whole `state.json` inventory and every record in
 * the log window, which after a `clone` is every note the account holds.
 * A reporter with a problem in one note shouldn't have to choose between
 * publishing everything and publishing nothing.
 */
export interface BugReportScope {
  /** recordNames of the scoped notes themselves, in `--note` order. */
  noteRecordNames: string[];
  /** Every recordName the report may include: the notes plus their
   * attachments and table attachments. */
  recordNames: Set<string>;
}

export function resolveBugReportScope(state: CloneState, noteFiles: readonly string[], targetDir: string): BugReportScope {
  const noteRecordNames: string[] = [];
  for (const fileArg of noteFiles) {
    const { recordName } = resolveTrackedNote(state, fileArg, targetDir);
    if (!noteRecordNames.includes(recordName)) {
      noteRecordNames.push(recordName);
    }
  }

  const recordNames = new Set(noteRecordNames);
  for (const [recordName, entry] of Object.entries(state.attachments ?? {})) {
    if (recordNames.has(entry.noteRecordName)) recordNames.add(recordName);
  }
  for (const [recordName, entry] of Object.entries(state.tableAttachments ?? {})) {
    if (recordNames.has(entry.noteRecordName)) recordNames.add(recordName);
  }
  return { noteRecordNames, recordNames };
}

/**
 * Narrows `state.json` to the scoped notes: their entries, the attachments
 * and tables they own, the folder chain each sits in (kept so the redacted
 * path can still be rebuilt from the record graph - see
 * `redactedNotePath`), and the sharer home of a shared note. Everything
 * else in the inventory - every other note, folder, sharer, and the trash
 * registry - is dropped. Vault-level scalars (sync tokens, replica id,
 * layout version, account) are kept: they're opaque, and they're exactly
 * what a report needs to be diagnosable.
 */
export function scopeCloneState(state: CloneState, scope: BugReportScope): CloneState {
  const notes: CloneState["notes"] = {};
  const folderRecordNames = new Set<string>();
  const sharerOwners = new Set<string>();
  for (const recordName of scope.noteRecordNames) {
    const entry = state.notes[recordName];
    if (!entry) continue;
    notes[recordName] = entry;
    if (entry.sharedZoneOwner) sharerOwners.add(entry.sharedZoneOwner);
    let current = entry.folderRecordName;
    while (current !== undefined && !folderRecordNames.has(current)) {
      folderRecordNames.add(current);
      current = state.folders?.[current]?.parentRecordName;
    }
  }

  const pick = <T>(source: Record<string, T> | undefined, keep: (key: string, entry: T) => boolean): Record<string, T> | undefined => {
    if (!source) return undefined;
    const out: Record<string, T> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (keep(key, entry)) out[key] = entry;
    }
    return out;
  };

  return {
    ...state,
    notes,
    folders: pick(state.folders, (key) => folderRecordNames.has(key)),
    sharerHomes: pick(state.sharerHomes, (key) => sharerOwners.has(key)),
    attachments: pick(state.attachments, (key) => scope.recordNames.has(key)),
    tableAttachments: pick(state.tableAttachments, (key) => scope.recordNames.has(key)),
    trashed: state.trashed ? {} : undefined,
  };
}

/** Name of the sibling key written next to any array this pass filtered
 * (`records` gets `recordsOmittedByScope`), so a reader of the report can
 * see that records were removed and how many, rather than mistaking a
 * trimmed `changes/zone` page for a sparse one. */
export function omittedByScopeKey(arrayKey: string): string {
  return `${arrayKey}OmittedByScope`;
}

export interface ScopedDebugLog {
  entries: DebugLogRecord[];
  /** Total records dropped across every entry - reported in the bundle. */
  recordsOmitted: number;
}

/**
 * Removes every record outside `scope` from the captured response bodies.
 * A record is any array element carrying a string `recordName` - that
 * covers the full records in `changes/zone` and `records/lookup` bodies
 * and the per-record results (`serverErrorCode`, `reason`) in a
 * `records/modify` body alike, without parsing each endpoint's shape.
 * Entries themselves are kept even when nothing in them survives: the
 * request URL, status, and timing are what a report about a network or
 * throttling failure needs, and a `records/modify` with an empty
 * `records` list still says the call happened.
 */
export function scopeDebugLogEntries(entries: readonly DebugLogRecord[], scope: BugReportScope): ScopedDebugLog {
  let recordsOmitted = 0;
  const scoped = entries.map((entry) => {
    if (!entry.response) return entry;
    const { value, omitted } = scopeValue(entry.response.body, scope.recordNames);
    recordsOmitted += omitted;
    return { ...entry, response: { ...entry.response, body: value } };
  });
  return { entries: scoped, recordsOmitted };
}

function scopeValue(value: unknown, recordNames: ReadonlySet<string>): { value: unknown; omitted: number } {
  if (Array.isArray(value)) {
    let omitted = 0;
    const kept: unknown[] = [];
    for (const item of value) {
      if (isRecordReference(item) && !recordNames.has(item.recordName)) {
        omitted += 1;
        continue;
      }
      const scoped = scopeValue(item, recordNames);
      omitted += scoped.omitted;
      kept.push(scoped.value);
    }
    return { value: kept, omitted };
  }
  if (value !== null && typeof value === "object") {
    let omitted = 0;
    const out: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      const scoped = scopeValue(fieldValue, recordNames);
      out[key] = scoped.value;
      if (Array.isArray(fieldValue) && scoped.omitted > 0) {
        const droppedHere = fieldValue.length - (scoped.value as unknown[]).length;
        if (droppedHere > 0) out[omittedByScopeKey(key)] = droppedHere;
      }
      omitted += scoped.omitted;
    }
    return { value: out, omitted };
  }
  return { value, omitted: 0 };
}

function isRecordReference(value: unknown): value is { recordName: string } {
  return typeof value === "object" && value !== null && typeof (value as { recordName?: unknown }).recordName === "string";
}
