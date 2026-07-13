import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * All request/response troubleshooting data lives here rather than on stdout,
 * in the same shared ~/.config/icloud-notes-sync/ directory session.ts writes
 * the session file to - see session.ts's DEFAULT_SESSION_PATH.
 */
export const DEFAULT_DEBUG_LOG_PATH = path.join(os.homedir(), ".config", "icloud-notes-sync", "debug.log");

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
 * fetch() wrapper that logs the request and a cloned copy of the response
 * (status, headers, best-effort JSON body) to the debug log, then returns the
 * original, still-unconsumed Response for the caller to read normally.
 */
export async function loggedFetch(
  note: string,
  url: string,
  init: RequestInit & { headers: Record<string, string> },
  debugLogPath: string = DEFAULT_DEBUG_LOG_PATH,
): Promise<Response> {
  const response = await fetch(url, init);

  const responseBody: unknown = await response
    .clone()
    .json()
    .catch(() => null);

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

  return response;
}
