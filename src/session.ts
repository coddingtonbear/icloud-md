import { readFile } from "node:fs/promises";
import path from "node:path";

/** A captured browser session: enough to make authenticated iCloud web-service requests. */
export interface IcloudSession {
  cookie: string;
  clientId: string;
  clientBuildNumber: string;
  clientMasteringNumber: string;
  capturedAt: string;
}

const DEFAULT_SESSION_PATH = path.join(process.cwd(), ".auth", "session.local.json");

export async function loadSession(sessionPath: string = DEFAULT_SESSION_PATH): Promise<IcloudSession> {
  let raw: string;
  try {
    raw = await readFile(sessionPath, "utf8");
  } catch (cause) {
    throw new Error(
      `No session file found at ${sessionPath}. Run "npm run import-har -- <path-to.har>" ` +
        "to create one from a browser HAR export (exported with sensitive data included).",
      { cause },
    );
  }

  const parsed: unknown = JSON.parse(raw);
  return assertIcloudSession(parsed, sessionPath);
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
