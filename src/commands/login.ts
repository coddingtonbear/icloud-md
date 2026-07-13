import { performBrowserLogin } from "../auth/browserLogin.js";
import { checkAuthentication } from "../cloudkit/setupClient.js";
import { writeSessionFile } from "../session.js";

/**
 * Login is a headed browser window where Apple's own pages run the entire
 * sign-in flow (any 2FA variant, CAPTCHAs, whatever they ship next), after
 * which we capture the session cookies and immediately verify them against
 * /validate - so a successful `login` is also proof the session works.
 */
export async function runLogin(sessionPath?: string): Promise<void> {
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
