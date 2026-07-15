import { checkAuthentication, type AuthCheckResult } from "../cloudkit/setupClient.js";
import { performBrowserLogin } from "./browserLogin.js";
import { AuthenticationExpiredError, SilentReauthFailedError } from "../errors.js";
import { DEFAULT_SESSION_PATH, persistSessionIfRotated, writeSessionFile, type IcloudSession } from "../session.js";

export type AuthCheckOk = Extract<AuthCheckResult, { ok: true }>;

const HEADLESS_RECOVERY_TIMEOUT_MS = 90_000;

export interface EnsureAuthenticatedDeps {
  checkAuth?: typeof checkAuthentication;
  recover?: typeof performBrowserLogin;
}

/**
 * Confirms `session` is authenticated, persisting any `/validate` cookie
 * rotation back to disk, and transparently recovering once from an expired
 * session (HTTP 421) before giving up: relaunches the persistent browser
 * profile headless and lets Apple's own JS attempt the same silent re-login a
 * live browser tab performs after its own session lapses (see the
 * 2026-07-13 dev notes - a real browser did exactly this after a multi-hour
 * idle period, with no human involved). Only worth trying when the profile
 * can recover on its own; if that fails (e.g. a fresh interactive 2FA is
 * actually required), the caller should fall back to `login`.
 */
export async function ensureAuthenticated(
  session: IcloudSession,
  sessionPath: string = DEFAULT_SESSION_PATH,
  deps: EnsureAuthenticatedDeps = {},
): Promise<AuthCheckOk> {
  const checkAuth = deps.checkAuth ?? checkAuthentication;
  const recover = deps.recover ?? performBrowserLogin;

  const auth = await checkAuth(session);
  if (auth.ok) {
    await persistSessionIfRotated(session, auth.session, sessionPath);
    return auth;
  }

  if (auth.status !== 421) {
    throw new AuthenticationExpiredError(auth.status, auth.error);
  }

  console.log("Session expired; attempting silent re-authentication via the persistent browser profile...");

  let recovered: IcloudSession;
  try {
    recovered = await recover({ headless: true, timeoutMs: HEADLESS_RECOVERY_TIMEOUT_MS });
  } catch (cause) {
    throw new SilentReauthFailedError(
      "Session expired, and silent (headless) re-authentication failed - this profile likely needs a human for " +
        "this sign-in.",
      { cause },
    );
  }

  const recoveredAuth = await checkAuth(recovered);
  if (!recoveredAuth.ok) {
    throw new SilentReauthFailedError(
      `Recovered a session via headless re-authentication, but it failed verification ` +
        `(HTTP ${recoveredAuth.status}): ${recoveredAuth.error}`,
    );
  }

  await writeSessionFile(recoveredAuth.session, sessionPath);
  console.log("Silent re-authentication succeeded; session refreshed.");
  return recoveredAuth;
}
