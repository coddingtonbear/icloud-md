import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";
import { STATE_DIR_NAME } from "./cloneState.js";

export const BUG_REPORT_ALIASES_FILE_NAME = "bug-report-aliases.json";

/**
 * Stable, arbitrary (not content-derived) aliases for the identifiers a bug
 * report would otherwise expose verbatim - note/folder/sharer/attachment
 * names and the account's dsid/appleId. Persisted locally per vault
 * (alongside state.json) so the same real note keeps the same `note-N`
 * alias across every future `bug-report`/`--identify` run, letting a
 * reporter reference "note-14" in conversation without ever typing its real
 * title. Aliases are assigned in first-seen order rather than derived from
 * the real value (e.g. a hash) on purpose - a content-derived alias for
 * something as low-entropy as a note title is crackable offline by a
 * motivated reader trying common titles against it.
 */
export interface BugReportAliasStore {
  notes: Record<string, string>;
  folders: Record<string, string>;
  sharerHomes: Record<string, string>;
  attachments: Record<string, string>;
  trashed: Record<string, string>;
  /** Keyed by the real dsid/appleId value itself (not a recordName - these
   * scalars have no other stable id to key off of). This file already sits
   * next to state.json, which stores the same real values in the clear, so
   * this doesn't add new exposure. */
  account: Record<string, string>;
}

const ALIAS_PREFIXES: Record<keyof BugReportAliasStore, string> = {
  notes: "note",
  folders: "folder",
  sharerHomes: "sharer",
  attachments: "attachment",
  trashed: "trashed",
  account: "account",
};

export function emptyAliasStore(): BugReportAliasStore {
  return { notes: {}, folders: {}, sharerHomes: {}, attachments: {}, trashed: {}, account: {} };
}

function aliasFilePath(targetDir: string): string {
  return path.join(targetDir, STATE_DIR_NAME, BUG_REPORT_ALIASES_FILE_NAME);
}

/** Reads the alias store, defaulting to empty if it's never been written or
 * doesn't parse - a bug-report run shouldn't fail over its own redaction
 * bookkeeping, it should just start fresh. */
export async function readAliasStore(targetDir: string): Promise<BugReportAliasStore> {
  let raw: string;
  try {
    raw = await readFile(aliasFilePath(targetDir), "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return emptyAliasStore();
    }
    throw cause;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeAliasStore(parsed);
  } catch {
    return emptyAliasStore();
  }
}

function normalizeAliasStore(value: unknown): BugReportAliasStore {
  const empty = emptyAliasStore();
  if (typeof value !== "object" || value === null) {
    return empty;
  }
  const record = value as Record<string, unknown>;
  for (const category of Object.keys(empty) as (keyof BugReportAliasStore)[]) {
    const section = record[category];
    if (typeof section === "object" && section !== null) {
      for (const [key, alias] of Object.entries(section as Record<string, unknown>)) {
        if (typeof alias === "string") {
          empty[category][key] = alias;
        }
      }
    }
  }
  return empty;
}

export async function writeAliasStore(targetDir: string, store: BugReportAliasStore): Promise<void> {
  const filePath = aliasFilePath(targetDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

/** Returns this key's existing alias, or mints and records the next one in
 * that category (`note-1`, `note-2`, ...). Mutates `store` in place. */
export function resolveAlias(store: BugReportAliasStore, category: keyof BugReportAliasStore, key: string): string {
  const existing = store[category][key];
  if (existing !== undefined) {
    return existing;
  }
  const nextIndex = Object.keys(store[category]).length + 1;
  const alias = `${ALIAS_PREFIXES[category]}-${nextIndex}`;
  store[category][key] = alias;
  return alias;
}
