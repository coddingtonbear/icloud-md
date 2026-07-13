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
