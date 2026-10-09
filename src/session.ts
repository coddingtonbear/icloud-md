import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CorruptSessionFileError, MissingSessionFileError } from "./errors.js";

/** A captured browser session: enough to make authenticated iCloud web-service requests. */
export interface IcloudSession {
  cookie: string;
  clientId: string;
  clientBuildNumber: string;
  clientMasteringNumber: string;
  capturedAt: string;
}

/**
 * Every session file lives under a specific Apple ID's own directory (see
 * `accountStore.ts`'s `accountSessionPath`), not at one shared path - a
 * machine can hold sessions for more than one account, each folder bound to
 * whichever one it was cloned for.
 */
export async function loadSession(sessionPath: string): Promise<IcloudSession> {
  let raw: string;
  try {
    raw = await readFile(sessionPath, "utf8");
  } catch (cause) {
    throw new MissingSessionFileError(sessionPath, { cause });
  }

  const parsed: unknown = JSON.parse(raw);
  return assertIcloudSession(parsed, sessionPath);
}

/**
 * Writes a session file with the same permissions convention import-har/login both rely on.
 *
 * The file is written to a temp file beside it and renamed into place, so a
 * reader never sees a half-written session and a crash mid-write leaves the
 * previous session intact. Writing in place truncated the file first: another
 * process reading it at that moment (a second sync, or another app sharing the
 * session) got a JSON parse error, and a process killed mid-write left a
 * corrupt file that only a fresh sign-in could replace.
 */
export async function writeSessionFile(session: IcloudSession, sessionPath: string): Promise<void> {
  await mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  const tempPath = `${sessionPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
    await renameReplacing(tempPath, sessionPath);
  } catch (err) {
    // Best-effort: a throw here would replace the error already being thrown
    // (a leftover temp file is harmless; a masked write failure is not).
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

/** Error codes Windows gives a rename onto a file another process holds open. */
const TRANSIENT_WINDOWS_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_STEP_MS = 20;

export interface RenameReplacingOptions {
  platform?: NodeJS.Platform;
  renameFile?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `rename`, retried briefly on Windows. There Node's rename does replace an
 * existing file (libuv uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`),
 * but it fails with EPERM, EACCES or EBUSY while another process - a virus
 * scanner, or another reader of the same session - has the target open.
 * Those clear within moments, so it retries for up to about a second, as
 * `write-file-atomic` and `graceful-fs` do. Elsewhere a rename is atomic and
 * those codes mean a real problem, so they're thrown straight away.
 */
export async function renameReplacing(from: string, to: string, options: RenameReplacingOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const renameFile = options.renameFile ?? rename;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (platform !== "win32" || attempt >= RENAME_ATTEMPTS || code === undefined || !TRANSIENT_WINDOWS_RENAME_CODES.has(code)) {
        throw err;
      }
      await sleep(RENAME_RETRY_STEP_MS * attempt);
    }
  }
}

/** Parses a `Name1=Value1; Name2=Value2` cookie header into a name→value map, preserving order. */
export function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  if (cookieHeader === "") {
    return cookies;
  }
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    cookies.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return cookies;
}

/** Extracts just the `Name=Value` pair from one `Set-Cookie` response header, ignoring its attributes. */
export function parseSetCookieName(setCookieHeader: string): { name: string; value: string } | undefined {
  const firstSegment = setCookieHeader.split(";")[0]?.trim();
  if (!firstSegment) {
    return undefined;
  }
  const eq = firstSegment.indexOf("=");
  if (eq === -1) {
    return undefined;
  }
  return { name: firstSegment.slice(0, eq), value: firstSegment.slice(eq + 1) };
}

/**
 * Merges rotated cookies from a response's `Set-Cookie` headers into a session's
 * cookie jar. Every `/validate` call rotates `X-APPLE-WEBAUTH-TOKEN` the same way
 * the browser's own 14-minute heartbeat does (see the dev notes); previously we
 * discarded that rotation and kept re-presenting the superseded token. Existing
 * cookie order is preserved (a rotated value updates in place); brand-new cookie
 * names are appended. Returns the same `session` object, unchanged, if nothing
 * actually rotated.
 */
export function mergeSetCookiesIntoSession(session: IcloudSession, setCookieHeaders: readonly string[]): IcloudSession {
  if (setCookieHeaders.length === 0) {
    return session;
  }

  const cookies = parseCookieHeader(session.cookie);
  let changed = false;
  for (const header of setCookieHeaders) {
    const parsed = parseSetCookieName(header);
    if (!parsed) {
      continue;
    }
    if (cookies.get(parsed.name) !== parsed.value) {
      changed = true;
    }
    cookies.set(parsed.name, parsed.value);
  }
  if (!changed) {
    return session;
  }

  const cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  return { ...session, cookie };
}

/** Writes `next` to disk only if its cookie jar actually differs from `previous` - avoids a pointless write on every call. */
export async function persistSessionIfRotated(
  previous: IcloudSession,
  next: IcloudSession,
  sessionPath: string,
): Promise<void> {
  if (next.cookie === previous.cookie) {
    return;
  }
  await writeSessionFile(next, sessionPath);
}

function assertIcloudSession(value: unknown, sessionPath: string): IcloudSession {
  const requiredStringFields = ["cookie", "clientId", "clientBuildNumber", "clientMasteringNumber", "capturedAt"] as const;

  if (typeof value !== "object" || value === null) {
    throw new CorruptSessionFileError(`Session file at ${sessionPath} does not contain a JSON object.`);
  }
  const record = value as Record<string, unknown>;

  for (const field of requiredStringFields) {
    if (typeof record[field] !== "string" || record[field] === "") {
      throw new CorruptSessionFileError(`Session file at ${sessionPath} is missing a non-empty "${field}" field.`);
    }
  }

  return {
    cookie: record.cookie as string,
    clientId: record.clientId as string,
    clientBuildNumber: record.clientBuildNumber as string,
    clientMasteringNumber: record.clientMasteringNumber as string,
    capturedAt: record.capturedAt as string,
  };
}
