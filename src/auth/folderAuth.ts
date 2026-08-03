import { checkAuthentication } from "../cloudkit/setupClient.js";
import {
  AccountMismatchError,
  InteractiveSignInRefusedError,
  NotClonedDirectoryError,
  SignInIncompleteError,
  RequestedAccountMismatchError,
  UnboundAccountError,
  UnknownAccountError,
} from "../errors.js";
import { readCloneState, type CloneStateAccount } from "../notes/cloneState.js";
import { loadSession, persistSessionIfRotated, writeSessionFile } from "../session.js";
import {
  accountProfileDir,
  accountSessionPath,
  discardEphemeralProfile,
  findAccount,
  listAccounts,
  newEphemeralProfileDir,
  promoteEphemeralProfile,
  readAccountMeta,
  writeAccountMeta,
  ACCOUNTS_ROOT,
  TMP_ROOT,
  type AccountMeta,
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

/**
 * May a sign-in that needs a human open a *visible* browser window?
 *
 * `true` (the default) is the person-at-a-terminal case the `clone` command
 * was written for. `false` is for unattended callers - CI, cron, the live
 * integration suite - where a window has nobody to complete it, so raising
 * `InteractiveSignInRefusedError` immediately is strictly better than
 * blocking on one. Headless attempts are unaffected either way: they open
 * nothing and either succeed on their own or fail quickly.
 */
interface InteractiveDep {
  interactive?: boolean;
}

export interface BindNewFolderAccountDeps extends CommonDeps, InteractiveDep {
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

  if (deps.interactive === false) {
    // This path exists to *ask* which account to use; there is no saved
    // sign-in to fall back on, so an unattended caller cannot get anywhere.
    throw new InteractiveSignInRefusedError(
      "Choosing which account to clone as requires a sign-in window, and --non-interactive was given.",
    );
  }

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
      // Best-effort: a throw here would replace whatever the try block is
      // already throwing (a leftover tmp dir is harmless; a masked sign-in
      // error is not).
      await discardEphemeralProfile(ephemeralProfileDir).catch(() => {});
    }
  }
}

/** How long a silent, headless reuse of a trusted profile is given before falling back to a visible window. */
const SILENT_BIND_TIMEOUT_MS = 60_000;

/**
 * The stored session for an already-known account, if it still authenticates.
 *
 * Tried before any browser launch, because relaunching the account's profile
 * is the step that has actually been seen to fail. On 2026-08-02, live run
 * 85e66f's mid-run `clone --account` could not complete a silent sign-in on
 * the profile, fell back to a window nobody was there to close, and cost 5.5
 * minutes for each remaining cloning test - while the stored session it never
 * tried went on serving every `push` and `pull` in that same run.
 *
 * That lapse has no demonstrated cause. Two candidates were probed and
 * neither reproduces it: a second Chromium opens a profile another one holds
 * without complaint (no `SingletonLock` is even written), and a silent
 * sign-in still succeeds after 17 minutes of such contention, despite the
 * held profile's `X-APPLE-WEBAUTH-TOKEN` rotating once a minute throughout.
 * So this is not a fix for a known race - it removes a dependency that was
 * never needed. A browser sign-in has many more ways to fail than an HTTP
 * call with a token we already hold, and the caller has already named the
 * identity it wants, so there is nothing the sign-in was disambiguating.
 *
 * `undefined` (rather than a throw) for every ordinary way this can come up
 * short - no session file yet, an unreadable one, an expired one - since each
 * just means the browser path has to run after all. An identity mismatch is
 * the exception: `accounts/<dsid>/session.local.json` authenticating as some
 * *other* dsid is an inconsistent store, not a stale one, and guessing past
 * it risks binding the folder to the wrong person's notes.
 */
async function reuseStoredSession(
  account: AccountMeta,
  accountsRoot: string,
  checkAuth: typeof checkAuthentication,
  onStatus: (message: string) => void,
): Promise<FolderAuth | undefined> {
  const sessionPath = accountSessionPath(account.dsid, accountsRoot);
  let stored;
  try {
    stored = await loadSession(sessionPath);
  } catch {
    return undefined;
  }

  const auth = await checkAuth(stored);
  if (!auth.ok) {
    return undefined;
  }
  if (auth.dsid !== account.dsid) {
    throw new RequestedAccountMismatchError(account.appleId, auth.appleId);
  }

  await persistSessionIfRotated(stored, auth.session, sessionPath);
  onStatus(`Reusing ${account.appleId}'s saved session.`);
  return auth;
}

/**
 * Used by `clone --account <appleId|dsid>`: binds a brand-new folder to an
 * account this machine has *already* signed into.
 *
 * `bindNewFolderAccount` deliberately refuses to reuse a persisted profile,
 * but its objection is to reusing one *silently* - a shared profile would let
 * iCloud's cookies decide the account, so the user could not tell which one
 * they got. Naming the account removes exactly that ambiguity: the caller has
 * said which identity they want, and whatever authenticates is checked against
 * it, so an unexpected account is an error rather than a silent substitution.
 *
 * Three attempts, cheapest first:
 *
 *  1. That account's *stored session* - the same one `pull`/`push` use, and
 *     the only step that touches no browser at all (see `reuseStoredSession`).
 *  2. A headless relaunch of the account's own Apple-trusted profile, which
 *     usually re-validates with no interaction.
 *  3. A visible window, since a human can finish what the profile couldn't -
 *     expired device trust, a fresh 2FA prompt, a CAPTCHA. Skipped, as a
 *     refusal, when `interactive` is false.
 */
export async function bindKnownAccount(reference: string, deps: CommonDeps & InteractiveDep = {}): Promise<FolderAuth> {
  const onStatus = deps.onStatus ?? (() => {});
  const login = deps.performBrowserLogin ?? performBrowserLogin;
  const checkAuth = deps.checkAuthentication ?? checkAuthentication;
  const accountsRoot = deps.accountsRoot ?? ACCOUNTS_ROOT;

  const account = await findAccount(reference, accountsRoot);
  if (!account) {
    const known = (await listAccounts(accountsRoot)).map((candidate) => candidate.appleId);
    throw new UnknownAccountError(reference, known);
  }

  const reused = await reuseStoredSession(account, accountsRoot, checkAuth, onStatus);
  if (reused) {
    return reused;
  }

  const profileDir = accountProfileDir(account.dsid, accountsRoot);
  let captured;
  try {
    captured = await login({ profileDir, headless: true, timeoutMs: SILENT_BIND_TIMEOUT_MS, onStatus });
  } catch (cause) {
    if (deps.interactive === false) {
      throw new InteractiveSignInRefusedError(
        `${account.appleId}'s saved session and saved sign-in could not be reused, and --non-interactive was given.`,
        { cause },
      );
    }
    onStatus(`Could not reuse ${account.appleId}'s saved sign-in silently - opening a browser window to finish it.`);
    captured = await login({ profileDir, onStatus });
  }

  const auth = await checkAuth(captured);
  if (!auth.ok) {
    throw new SignInIncompleteError(`Captured a session, but it failed verification (HTTP ${auth.status}): ${auth.error}`);
  }
  if (auth.dsid !== account.dsid) {
    throw new RequestedAccountMismatchError(account.appleId, auth.appleId);
  }

  await writeSessionFile(auth.session, accountSessionPath(auth.dsid, accountsRoot));
  await writeAccountMeta({ appleId: auth.appleId, dsid: auth.dsid }, accountsRoot);
  return auth;
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
