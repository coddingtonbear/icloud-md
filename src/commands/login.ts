import { DEFAULT_CLIENT_BUILD_NUMBER, DEFAULT_CLIENT_MASTERING_NUMBER } from "../auth/clientConstants.js";
import { performLogin, REAL_IDMSA_OPERATIONS } from "../auth/login.js";
import { promptHiddenLine, promptLine } from "../auth/prompt.js";
import { loadSession, writeSessionFile } from "../session.js";

async function readExistingTrustToken(sessionPath: string | undefined): Promise<string | undefined> {
  try {
    return (await loadSession(sessionPath)).trustToken;
  } catch {
    // No prior session, or it's malformed/HAR-imported (no trust token) -
    // always safe to fall back to a full 2FA login.
    return undefined;
  }
}

export async function runLogin(sessionPath?: string): Promise<void> {
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
