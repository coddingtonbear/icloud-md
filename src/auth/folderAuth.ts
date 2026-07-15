import { checkAuthentication } from "../cloudkit/setupClient.js";
import { AccountMismatchError, NotClonedDirectoryError, SignInIncompleteError, UnboundAccountError } from "../errors.js";
import { readCloneState, type CloneStateAccount } from "../notes/cloneState.js";
import { loadSession, writeSessionFile } from "../session.js";
import {
  accountProfileDir,
  accountSessionPath,
  discardEphemeralProfile,
  newEphemeralProfileDir,
  promoteEphemeralProfile,
  readAccountMeta,
  writeAccountMeta,
  ACCOUNTS_ROOT,
  TMP_ROOT,
} from "./accountStore.js";
import { performBrowserLogin } from "./browserLogin.js";
import { ensureAuthenticated, type AuthCheckOk } from "./ensureAuthenticated.js";

export type FolderAuth = AuthCheckOk;

/**
 * Shared by all three functions below. `onStatus` defaults to a no-op (not
 * `console.log`) so they stay side-effect-free as library functions, same as
 * `runClone`/`runPull` themselves - the CLI layer is the only place that
 * should print. The rest exist purely so tests can substitute a fake
 * login/verification flow and a temp accounts directory instead of driving a
 * real browser against `~/.config`.
 */
interface CommonDeps {
  onStatus?: ((message: string) => void) | undefined;
  performBrowserLogin?: typeof performBrowserLogin;
  checkAuthentication?: typeof checkAuthentication;
  accountsRoot?: string;
}

export interface BindNewFolderAccountDeps extends CommonDeps {
  tmpRoot?: string;
}

/**
 * Used by `clone` on a brand-new (never-cloned) folder: always runs a real
 * interactive login through a fresh, throwaway profile - never one of the
 * existing persisted per-account profiles, and never a shared "picker"
 * profile either, since either would let iCloud's own session cookies
 * silently auto-resume as whoever last used it, defeating the point of
 * asking. Once sign-in completes, the real dsid tells us which account this
 * is: an existing account's stored session just gets refreshed (its own
 * profile left untouched, already trusted); a brand-new dsid gets its own
 * account directory, with the ephemeral profile promoted into it so it too
 * gets device-trust reuse starting next time, instead of paying for fresh
 * 2FA on every future reauth. The caller (`clone`) is responsible for
 * recording the returned identity into that folder's `state.json`.
 */
export async function bindNewFolderAccount(deps: BindNewFolderAccountDeps = {}): Promise<FolderAuth> {
  const onStatus = deps.onStatus ?? (() => {});
  const login = deps.performBrowserLogin ?? performBrowserLogin;
  const checkAuth = deps.checkAuthentication ?? checkAuthentication;
  const accountsRoot = deps.accountsRoot ?? ACCOUNTS_ROOT;
  const tmpRoot = deps.tmpRoot ?? TMP_ROOT;

  const ephemeralProfileDir = await newEphemeralProfileDir(tmpRoot);
  let promoted = false;

  try {
    const captured = await login({ profileDir: ephemeralProfileDir, onStatus });
    const auth = await checkAuth(captured);
    if (!auth.ok) {
      throw new SignInIncompleteError(`Captured a session, but it failed verification (HTTP ${auth.status}): ${auth.error}`);
    }

    const existingAccount = await readAccountMeta(auth.dsid, accountsRoot);
    await writeSessionFile(auth.session, accountSessionPath(auth.dsid, accountsRoot));
    await writeAccountMeta({ appleId: auth.appleId, dsid: auth.dsid }, accountsRoot);

    if (!existingAccount) {
      await promoteEphemeralProfile(ephemeralProfileDir, auth.dsid, accountsRoot);
      promoted = true;
    }

    return auth;
  } finally {
    if (!promoted) {
      await discardEphemeralProfile(ephemeralProfileDir);
    }
  }
}

export interface ResolveFolderAccountDeps extends CommonDeps {
  ensureAuthenticated?: typeof ensureAuthenticated;
}

/**
 * Used by `pull`/`push`/`verify-auth`: resolves an already-cloned folder's
 * bound account to a live, verified session - transparently, no flag, no
 * visible "account" concept. `account` should come from that folder's
 * already-loaded `state.json` (callers already read it for their own
 * purposes, so this doesn't re-read the file). Headless 421 recovery reuses
 * that same account's own persisted browser profile, and the resulting
 * identity is re-checked against `account` either way - a mismatch throws
 * `AccountMismatchError` rather than silently trusting whatever came back.
 */
export async function resolveFolderAccount(
  targetDir: string,
  account: CloneStateAccount | undefined,
  deps: ResolveFolderAccountDeps = {},
): Promise<FolderAuth> {
  if (!account) {
    throw new UnboundAccountError(targetDir);
  }

  const onStatus = deps.onStatus ?? (() => {});
  const login = deps.performBrowserLogin ?? performBrowserLogin;
  const ensureAuth = deps.ensureAuthenticated ?? ensureAuthenticated;
  const accountsRoot = deps.accountsRoot ?? ACCOUNTS_ROOT;

  const sessionPath = accountSessionPath(account.dsid, accountsRoot);
  const session = await loadSession(sessionPath);
  const auth = await ensureAuth(session, sessionPath, {
    recover: (options) => login({ ...options, profileDir: accountProfileDir(account.dsid, accountsRoot), onStatus }),
  });

  if (auth.dsid !== account.dsid) {
    throw new AccountMismatchError(targetDir, account.appleId, auth.appleId);
  }
  return auth;
}

export type ReauthenticateFolderDeps = CommonDeps;

/**
 * Used by `reauthenticate <dir>`: forces a fresh interactive login against
 * an already-cloned folder's bound account, via that account's own
 * persisted profile (so device trust still applies and 2FA is typically
 * still skipped). Refuses - `AccountMismatchError` - if the completed
 * sign-in turns out to be for a different Apple ID than the one this folder
 * was cloned for, rather than silently rebinding it.
 */
export async function reauthenticateFolder(targetDir: string, deps: ReauthenticateFolderDeps = {}): Promise<FolderAuth> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }
  if (!state.account) {
    throw new UnboundAccountError(targetDir);
  }
  const { appleId: expectedAppleId, dsid: expectedDsid } = state.account;

  const onStatus = deps.onStatus ?? (() => {});
  const login = deps.performBrowserLogin ?? performBrowserLogin;
  const checkAuth = deps.checkAuthentication ?? checkAuthentication;
  const accountsRoot = deps.accountsRoot ?? ACCOUNTS_ROOT;

  const captured = await login({ profileDir: accountProfileDir(expectedDsid, accountsRoot), onStatus });
  const auth = await checkAuth(captured);
  if (!auth.ok) {
    throw new SignInIncompleteError(`Captured a session, but it failed verification (HTTP ${auth.status}): ${auth.error}`);
  }
  if (auth.dsid !== expectedDsid) {
    throw new AccountMismatchError(targetDir, expectedAppleId, auth.appleId);
  }

  await writeSessionFile(auth.session, accountSessionPath(auth.dsid, accountsRoot));
  await writeAccountMeta({ appleId: auth.appleId, dsid: auth.dsid }, accountsRoot);
  return auth;
}
