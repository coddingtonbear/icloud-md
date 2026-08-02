import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "./configDir.js";
import { isEnoent } from "./fsUtil.js";

/**
 * All request/response troubleshooting data lives here rather than on stdout,
 * in the same shared ~/.config/icloud-md/ directory that holds every
 * account's own subdirectory (see accountStore.ts) - this log itself stays
 * one file across all accounts, since it's just raw (redacted) HTTP traffic.
 */
export const DEFAULT_DEBUG_LOG_PATH = path.join(CONFIG_DIR, "debug.log");

const SENSITIVE_HEADER_NAMES = new Set([
  "cookie",
  "set-cookie",
  "scnt",
  "x-apple-id-session-id",
  "x-apple-session-token",
  "x-apple-twosv-trust-token",
]);

// Field names, anywhere in a request/response JSON body, whose values grant
// account access or complete a live login and so shouldn't end up in a log
// file a user might paste into a public GitHub issue.
const SENSITIVE_BODY_FIELDS = new Set([
  "a",
  "b",
  "c",
  "m1",
  "m2",
  "sessionToken",
  "trustToken",
  "trustTokens",
  "dsWebAuthToken",
  "securityCode",
]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? `[REDACTED, ${value.length} chars]` : value;
  }
  return redacted;
}

function redactBody(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactBody);
  }
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = SENSITIVE_BODY_FIELDS.has(key) ? "[REDACTED]" : redactBody(fieldValue);
    }
    return redacted;
  }
  return value;
}

export interface DebugLogEntry {
  note: string;
  request?: { method: string; url: string; headers: Record<string, string> };
  response?: { status: number; headers: Record<string, string>; body: unknown };
}

/** One line as actually written by `appendDebugLog` - the entry plus the timestamp it adds. */
export type DebugLogRecord = DebugLogEntry & { timestamp: string };

/** Appends one JSON-lines record. Sensitive header/body values are redacted before writing. */
export async function appendDebugLog(entry: DebugLogEntry, debugLogPath: string = DEFAULT_DEBUG_LOG_PATH): Promise<void> {
  await mkdir(path.dirname(debugLogPath), { recursive: true, mode: 0o700 });

  const record = {
    timestamp: new Date().toISOString(),
    note: entry.note,
    ...(entry.request
      ? { request: { method: entry.request.method, url: entry.request.url, headers: redactHeaders(entry.request.headers) } }
      : {}),
    ...(entry.response
      ? {
          response: {
            status: entry.response.status,
            headers: redactHeaders(entry.response.headers),
            body: redactBody(entry.response.body),
          },
        }
      : {}),
  };

  await appendFile(debugLogPath, JSON.stringify(record) + "\n", { mode: 0o600 });
}

/**
 * fetch() wrapper that logs the request and the response (status, headers,
 * best-effort JSON body) to the debug log, then hands the caller a Response
 * it can read normally.
 *
 * The body is read *once* here and a fresh `Response` is built around those
 * bytes. The previous revision logged from `response.clone()` and returned
 * the original for the caller to read, which broke against real CloudKit
 * traffic: every `changes/zone` fetch for a zone of any size came back to the
 * caller as `TypeError: Body is unusable: Body has already been read` from
 * its own `response.json()`, making `object list` unable to complete at all
 * (2026-08-02).
 *
 * What exactly upsets undici about that clone is *not* established: the
 * failure reproduces reliably against the live endpoint and did not reproduce
 * against a local server given the same response shape (gzip, chunked,
 * ~1 MB of JSON, sequential paged requests on a keep-alive connection, a
 * file-write await between the two reads). So the fix is the conservative
 * one - never hold two readers of the same body - rather than a workaround
 * aimed at a mechanism we would only be guessing at.
 */
export async function loggedFetch(
  note: string,
  url: string,
  init: RequestInit & { headers: Record<string, string> },
  debugLogPath: string = DEFAULT_DEBUG_LOG_PATH,
): Promise<Response> {
  const response = await fetch(url, init);
  // Bytes, not text: `fetchAssetBytes` downloads real binary attachments
  // through this same wrapper, and a decode/re-encode round trip would
  // corrupt them.
  const body = await response.arrayBuffer();

  let responseBody: unknown = null;
  if ((response.headers.get("content-type") ?? "").includes("json")) {
    try {
      responseBody = JSON.parse(new TextDecoder().decode(body));
    } catch {
      // Malformed JSON: logged as null, exactly as the previous
      // `.json().catch(() => null)` did. Non-JSON responses (attachment
      // bytes, HTML error pages) took that same path before and still do -
      // they are skipped by the content-type check rather than decoded,
      // so a large download is no longer parsed just to be discarded.
    }
  }

  await appendDebugLog(
    {
      note,
      request: { method: init.method ?? "GET", url, headers: init.headers },
      response: {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      },
    },
    debugLogPath,
  );

  // 204/205/304 (and 101) may not carry a body at all - constructing one
  // with bytes attached throws.
  const bodylessStatus = response.status === 101 || response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(bodylessStatus ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Reads every already-redacted record logged at or after `since` - the slice
 * `bug-report` bundles. The log is one file shared across every account and
 * folder ever used on this machine (see the module doc comment above), so
 * this can't scope by folder; only the time range narrows it. Lines that
 * aren't valid JSON (or don't match the expected shape) are skipped rather
 * than failing the whole read - defensive against a log file interrupted
 * mid-write or hand-edited.
 */
export async function readDebugLogSince(since: Date, debugLogPath: string = DEFAULT_DEBUG_LOG_PATH): Promise<DebugLogRecord[]> {
  let raw: string;
  try {
    raw = await readFile(debugLogPath, "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return [];
    }
    throw cause;
  }

  const records: DebugLogRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const record = parseDebugLogLine(line);
    if (record && Date.parse(record.timestamp) >= since.getTime()) {
      records.push(record);
    }
  }
  return records;
}

function parseDebugLogLine(line: string): DebugLogRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { timestamp?: unknown }).timestamp !== "string" ||
    typeof (parsed as { note?: unknown }).note !== "string"
  ) {
    return undefined;
  }
  // An unparseable (but string-typed) timestamp isn't rejected here - it
  // naturally fails the `>= since` comparison in `readDebugLogSince` (NaN
  // compares false against anything), so a second `Date.parse` here would
  // just duplicate that check.
  return parsed as DebugLogRecord;
}
