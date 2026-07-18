import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "./configDir.js";
import { IcloudNotesSyncError } from "./errors.js";
import { isEnoent } from "./fsUtil.js";

/** Same shared `~/.config/icloud-md/` directory as the debug log and
 * account store - see `debugLog.ts`'s `DEFAULT_DEBUG_LOG_PATH`. */
export const DEFAULT_LAST_ERROR_PATH = path.join(CONFIG_DIR, "last-error.json");

export interface LastErrorRecord {
  timestamp: string;
  message: string;
  hint?: string;
}

/**
 * Persists the message/hint of the most recent CLI failure, so `bug-report`
 * can include it verbatim rather than relying on the user to have copied it
 * from a scrolled-past terminal. Overwrites any previous record - only the
 * latest failure matters for troubleshooting.
 */
export async function recordLastError(error: unknown, filePath: string = DEFAULT_LAST_ERROR_PATH): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof IcloudNotesSyncError ? error.hint : undefined;

  const record: LastErrorRecord = {
    timestamp: new Date().toISOString(),
    message,
    ...(hint !== undefined ? { hint } : {}),
  };

  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

/** Returns `undefined` if no failure has been recorded yet (or the file was removed). */
export async function readLastError(filePath: string = DEFAULT_LAST_ERROR_PATH): Promise<LastErrorRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return undefined;
    }
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated/corrupt file (e.g. the process was killed mid-write) is
    // "nothing usable to report", not a reason for `bug-report` itself to fail.
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { timestamp?: unknown }).timestamp !== "string" ||
    typeof (parsed as { message?: unknown }).message !== "string"
  ) {
    return undefined;
  }
  const { timestamp, message, hint } = parsed as { timestamp: string; message: string; hint?: unknown };
  return { timestamp, message, ...(typeof hint === "string" ? { hint } : {}) };
}
