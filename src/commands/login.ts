import { performBrowserLogin } from "../auth/browserLogin.js";
import { DEFAULT_CLIENT_BUILD_NUMBER, DEFAULT_CLIENT_MASTERING_NUMBER } from "../auth/clientConstants.js";
import { performLogin, REAL_IDMSA_OPERATIONS } from "../auth/login.js";
import { promptHiddenLine, promptLine } from "../auth/prompt.js";
import { checkAuthentication } from "../cloudkit/setupClient.js";
import { loadSession, writeSessionFile } from "../session.js";

/**
 * The default login path: a headed browser window where Apple's own pages run
 * the entire sign-in flow (any 2FA variant, CAPTCHAs, whatever they ship next),
 * after which we capture the session cookies and immediately verify them
 * against /validate - so a successful `login` is also proof the session works.
 */
export async function runBrowserLogin(sessionPath?: string): Promise<void> {
  console.log("Opening a browser window for iCloud sign-in...");
  const session = await performBrowserLogin();

  console.log("Sign-in detected; verifying the captured session...");
  const result = await checkAuthentication(session);
  if (!result.ok) {
    console.error(`Captured a session, but it failed verification (HTTP ${result.status}): ${result.error}`);
    process.exitCode = 1;
    return;
  }

  await writeSessionFile(session, sessionPath);
  console.log(`Login successful. Authenticated as ${result.appleId} (dsid ${result.dsid}).`);
  console.log(`Session written${sessionPath ? ` to ${sessionPath}` : ""}.`);
}

async function readExistingTrustToken(sessionPath: string | undefined): Promise<string | undefined> {
  try {
    return (await loadSession(sessionPath)).trustToken;
  } catch {
    // No prior session, or it's malformed/HAR-imported (no trust token) -
    // always safe to fall back to a full 2FA login.
    return undefined;
  }
}

/**
 * Direct SRP login against idmsa.apple.com, kept as an opt-in fallback
 * (`login --srp`) for headless environments. Only works for accounts that
 * don't need interactive 2FA (or hold a still-valid trust token): the
 * trusted-device push flow the web client uses (bridge/*) is device-attested
 * and can't be replicated with plain HTTP - see the project dev notes.
 */
export async function runSrpLogin(sessionPath?: string): Promise<void> {
  const accountName = await promptLine("Apple ID: ");
  const password = await promptHiddenLine("Password: ");
  const existingTrustToken = await readExistingTrustToken(sessionPath);

  console.log("Signing in...");

  const result = await performLogin(
    accountName,
    password,
    existingTrustToken,
    () => promptLine("Enter the 6-digit verification code sent to your trusted devices: "),
    DEFAULT_CLIENT_BUILD_NUMBER,
    DEFAULT_CLIENT_MASTERING_NUMBER,
    REAL_IDMSA_OPERATIONS,
  );

  if (result.outcome === "unsupportedTwoFactor") {
    console.error(result.detail);
    process.exitCode = 1;
    return;
  }

  await writeSessionFile(result.session, sessionPath);
  console.log(`Login successful. Session written${sessionPath ? ` to ${sessionPath}` : ""}.`);
}
