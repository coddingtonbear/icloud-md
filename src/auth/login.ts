import { Hash, Mode, Srp } from "@foxt/js-srp";
import type { IcloudSession } from "../session.js";
import { deriveSrpPassword } from "./passwordDerivation.js";
import { EMPTY_IDMSA_CONTEXT, type IdmsaContext } from "./idmsaContext.js";
import {
  signInInit,
  signInComplete,
  submitTrustedDeviceCode,
  fetchTwoSvTrust,
} from "./idmsaClient.js";
import { mintIcloudSessionCookie } from "./accountLogin.js";
import { DEFAULT_DEBUG_LOG_PATH } from "../debugLog.js";

const ISSUES_URL = "https://github.com/coddingtonbear/icloud-notes-sync/issues";

export type LoginResult =
  | { outcome: "success"; session: IcloudSession }
  | { outcome: "unsupportedTwoFactor"; detail: string };

export interface IdmsaOperations {
  signInInit: typeof signInInit;
  signInComplete: typeof signInComplete;
  submitTrustedDeviceCode: typeof submitTrustedDeviceCode;
  fetchTwoSvTrust: typeof fetchTwoSvTrust;
  mintIcloudSessionCookie: typeof mintIcloudSessionCookie;
}

export const REAL_IDMSA_OPERATIONS: IdmsaOperations = {
  signInInit,
  signInComplete,
  submitTrustedDeviceCode,
  fetchTwoSvTrust,
  mintIcloudSessionCookie,
};

function announceTwoFactorPrompt(): void {
  console.error(
    `[2FA] Waiting for a code. The full signInComplete request/response (including fields like ` +
      `trustedDeviceCount/authType that explain whether a push was actually sent) was recorded in ` +
      `${DEFAULT_DEBUG_LOG_PATH} - check it if no push notification arrives.`,
  );
}

function unsupportedTwoFactorDetail(stage: string, httpStatus: number, body: unknown): string {
  const bodyPreview = JSON.stringify(body)?.slice(0, 500) ?? "(no body)";
  return (
    `Unexpected response during ${stage} (HTTP ${httpStatus}). ` +
    "This login flow only supports the trusted-device push notification 2FA method. " +
    "If your Apple ID uses SMS/phone-based two-factor verification (or something else), " +
    `this isn't supported yet - please file an issue at ${ISSUES_URL} describing what you saw ` +
    `(response body: ${bodyPreview}).`
  );
}

/**
 * Performs a full Apple ID SRP + (trusted-device) 2FA login against
 * idmsa.apple.com, producing a fresh IcloudSession. The idmsa HTTP calls and
 * the 2FA code prompt are both injected (via `ops`/`promptForCode`) so this
 * orchestration/branching logic is unit-testable without a real network or
 * TTY - see login.test.ts.
 */
export async function performLogin(
  accountName: string,
  password: string,
  existingTrustToken: string | undefined,
  promptForCode: () => Promise<string>,
  clientBuildNumber: string,
  clientMasteringNumber: string,
  ops: IdmsaOperations,
): Promise<LoginResult> {
  const srp = new Srp(Mode.GSA, Hash.SHA256, 2048);
  // Placeholder password: A doesn't depend on p, and Client.p is mutable
  // specifically so the real (server-salt-derived) password can be filled
  // in once signInInit responds.
  const client = await srp.newClient(new TextEncoder().encode(accountName), new Uint8Array(0));

  const init = await ops.signInInit(accountName, client.A, EMPTY_IDMSA_CONTEXT);

  client.p = deriveSrpPassword(password, init.salt, init.iterationCount, init.protocol);
  await client.generate(init.salt, init.serverPublicValue);
  const m2 = await client.generateM2();

  const trustTokens = existingTrustToken ? [existingTrustToken] : [];
  const complete = await ops.signInComplete(accountName, client.M, m2, init.c, trustTokens, init.context);

  if (complete.status === "unexpected") {
    return { outcome: "unsupportedTwoFactor", detail: unsupportedTwoFactorDetail("sign-in", complete.httpStatus, complete.body) };
  }

  if (complete.status === "trusted") {
    const cookie = await ops.mintIcloudSessionCookie(complete.sessionToken);
    return { outcome: "success", session: buildSession(cookie, clientBuildNumber, clientMasteringNumber, existingTrustToken) };
  }

  announceTwoFactorPrompt();
  const contextWithSessionId: IdmsaContext = { ...complete.context, sessionId: complete.sessionToken };
  const code = await promptForCode();
  const verify = await ops.submitTrustedDeviceCode(code, contextWithSessionId);

  if (verify.status === "unexpected") {
    return { outcome: "unsupportedTwoFactor", detail: unsupportedTwoFactorDetail("2FA code submission", verify.httpStatus, verify.body) };
  }
  if (verify.status === "rejected") {
    return { outcome: "unsupportedTwoFactor", detail: "The verification code was rejected. Run \"login\" again to retry." };
  }

  const trust = await ops.fetchTwoSvTrust(verify.context);
  const cookie = await ops.mintIcloudSessionCookie(trust.sessionToken);
  return { outcome: "success", session: buildSession(cookie, clientBuildNumber, clientMasteringNumber, trust.trustToken) };
}

function buildSession(
  cookie: string,
  clientBuildNumber: string,
  clientMasteringNumber: string,
  trustToken: string | undefined,
): IcloudSession {
  return {
    cookie,
    clientId: crypto.randomUUID(),
    clientBuildNumber,
    clientMasteringNumber,
    capturedAt: new Date().toISOString(),
    ...(trustToken !== undefined ? { trustToken } : {}),
  };
}
