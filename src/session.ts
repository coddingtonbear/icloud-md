import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A captured browser session: enough to make authenticated iCloud web-service requests. */
export interface IcloudSession {
  cookie: string;
  clientId: string;
  clientBuildNumber: string;
  clientMasteringNumber: string;
  capturedAt: string;
}

/**
 * One shared session in ~/.config/, not per-clone-directory: `login` happens
 * once, and any number of `clone`/`pull` targets reuse it. Only supports one
 * Apple ID at a time - fine for a personal tool, would need a profile/name
 * argument to support more.
 */
export const DEFAULT_SESSION_PATH = path.join(os.homedir(), ".config", "icloud-notes-sync", "session.local.json");

export async function loadSession(sessionPath: string = DEFAULT_SESSION_PATH): Promise<IcloudSession> {
  let raw: string;
  try {
    raw = await readFile(sessionPath, "utf8");
  } catch (cause) {
    throw new Error(
      `No session file found at ${sessionPath}. Run "npm run cli -- login" (or "npm run import-har -- ` +
        '<path-to.har>" from a browser HAR export) to create one.',
      { cause },
    );
  }

  const parsed: unknown = JSON.parse(raw);
  return assertIcloudSession(parsed, sessionPath);
}

/** Writes a session file with the same permissions convention import-har/login both rely on. */
export async function writeSessionFile(session: IcloudSession, sessionPath: string = DEFAULT_SESSION_PATH): Promise<void> {
  await mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  await writeFile(sessionPath, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
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
  sessionPath: string = DEFAULT_SESSION_PATH,
): Promise<void> {
  if (next.cookie === previous.cookie) {
    return;
  }
  await writeSessionFile(next, sessionPath);
}

function assertIcloudSession(value: unknown, sessionPath: string): IcloudSession {
  const requiredStringFields = ["cookie", "clientId", "clientBuildNumber", "clientMasteringNumber", "capturedAt"] as const;

  if (typeof value !== "object" || value === null) {
    throw new Error(`Session file at ${sessionPath} does not contain a JSON object.`);
  }
  const record = value as Record<string, unknown>;

  for (const field of requiredStringFields) {
    if (typeof record[field] !== "string" || record[field] === "") {
      throw new Error(`Session file at ${sessionPath} is missing a non-empty "${field}" field.`);
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
