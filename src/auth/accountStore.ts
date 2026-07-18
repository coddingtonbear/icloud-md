import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "../configDir.js";
import { isEnoent } from "../fsUtil.js";

/**
 * Every Apple ID this machine has ever signed into gets its own subdirectory
 * here - `session.local.json`, a persistent Playwright `browser-profile/`
 * (for device-trust reuse), and `meta.json` (`{ appleId, dsid }`). A cloned
 * folder never holds any of this itself; it only records which account's
 * subdirectory to use (see `CloneState.account` in `cloneState.ts`) - so
 * copying/zipping/syncing a vault elsewhere never carries live credentials
 * with it. See the "Store authentication per-folder during `clone`"
 * Development Log entries for the reasoning behind this split.
 *
 * Every function below takes the accounts-root directory as its last
 * parameter, defaulted to this real path - tests substitute a temp
 * directory instead, so nothing here ever touches a real `~/.config`.
 */
export const ACCOUNTS_ROOT = path.join(CONFIG_DIR, "accounts");

/** Scratch space for the throwaway login profile used to discover a new/unbound folder's account - see `folderAuth.ts`. */
export const TMP_ROOT = path.join(CONFIG_DIR, "tmp");

export interface AccountMeta {
  appleId: string;
  dsid: string;
}

export function accountDir(dsid: string, accountsRoot: string = ACCOUNTS_ROOT): string {
  return path.join(accountsRoot, dsid);
}

export function accountSessionPath(dsid: string, accountsRoot: string = ACCOUNTS_ROOT): string {
  return path.join(accountDir(dsid, accountsRoot), "session.local.json");
}

export function accountProfileDir(dsid: string, accountsRoot: string = ACCOUNTS_ROOT): string {
  return path.join(accountDir(dsid, accountsRoot), "browser-profile");
}

function accountMetaPath(dsid: string, accountsRoot: string): string {
  return path.join(accountDir(dsid, accountsRoot), "meta.json");
}

export async function writeAccountMeta(meta: AccountMeta, accountsRoot: string = ACCOUNTS_ROOT): Promise<void> {
  await mkdir(accountDir(meta.dsid, accountsRoot), { recursive: true, mode: 0o700 });
  await writeFile(accountMetaPath(meta.dsid, accountsRoot), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
}

/** Returns `undefined` if this dsid has never been seen on this machine (no `meta.json` yet). */
export async function readAccountMeta(dsid: string, accountsRoot: string = ACCOUNTS_ROOT): Promise<AccountMeta | undefined> {
  let raw: string;
  try {
    raw = await readFile(accountMetaPath(dsid, accountsRoot), "utf8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return undefined;
    }
    throw cause;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.appleId !== "string" || typeof parsed.dsid !== "string") {
    return undefined;
  }
  return { appleId: parsed.appleId, dsid: parsed.dsid };
}

/** A fresh, never-before-used profile directory for the one-time login that discovers a new/unbound folder's account. */
export async function newEphemeralProfileDir(tmpRoot: string = TMP_ROOT): Promise<string> {
  const dir = path.join(tmpRoot, `login-${randomBytes(8).toString("hex")}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Discards an ephemeral profile that turned out not to be needed (its dsid
 * already had an account, or the login failed). Retries because Chromium can
 * still be flushing files into the profile right after the context closes,
 * which makes a single recursive rm lose the race with an ENOTEMPTY
 * (observed 2026-07-18: that ENOTEMPTY escaped a `finally` and masked the
 * real sign-in error).
 */
export async function discardEphemeralProfile(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * Promotes a just-used ephemeral profile into a brand-new account's
 * persisted `browser-profile/`, so it keeps carrying device trust from here
 * on rather than needing fresh 2FA on every future reauth. Same-filesystem
 * rename (both live under the same accounts/tmp root), so this can't fail
 * partway across a device boundary.
 */
export async function promoteEphemeralProfile(ephemeralDir: string, dsid: string, accountsRoot: string = ACCOUNTS_ROOT): Promise<void> {
  await mkdir(accountDir(dsid, accountsRoot), { recursive: true, mode: 0o700 });
  await rm(accountProfileDir(dsid, accountsRoot), { recursive: true, force: true });
  await rename(ephemeralDir, accountProfileDir(dsid, accountsRoot));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
