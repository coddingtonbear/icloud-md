import { util } from "@foxt/js-srp";
import { APPLE_OAUTH_CLIENT_ID, APPLE_WIDGET_KEY } from "./clientConstants.js";
import { EMPTY_IDMSA_CONTEXT, updateIdmsaContext, type IdmsaContext } from "./idmsaContext.js";
import type { SrpProtocol } from "./passwordDerivation.js";
import { loggedFetch } from "../debugLog.js";

const IDMSA_BASE = "https://idmsa.apple.com/appleauth/auth";

export interface SignInInitResult {
  salt: Uint8Array;
  iterationCount: number;
  protocol: SrpProtocol;
  serverPublicValue: Uint8Array;
  /** Apple's "c" session id - echoed back verbatim in signInComplete's body, unrelated to IdmsaContext.sessionId. */
  c: string;
  context: IdmsaContext;
}

export type SignInCompleteResult =
  | { status: "trusted"; sessionToken: string; context: IdmsaContext; body: unknown }
  | { status: "needsTwoFactor"; sessionToken: string; context: IdmsaContext; body: unknown }
  | { status: "unexpected"; httpStatus: number; body: unknown; context: IdmsaContext };

export type SubmitTrustedDeviceCodeResult =
  | { status: "accepted"; context: IdmsaContext }
  | { status: "rejected"; context: IdmsaContext }
  | { status: "unexpected"; httpStatus: number; body: unknown; context: IdmsaContext };

export interface TwoSvTrustResult {
  trustToken: string;
  sessionToken: string;
}

function buildHeaders(context: IdmsaContext): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: "https://idmsa.apple.com",
    Referer: "https://idmsa.apple.com/",
    "X-Apple-Widget-Key": APPLE_WIDGET_KEY,
    "X-Apple-OAuth-Client-Id": APPLE_OAUTH_CLIENT_ID,
    "X-Apple-OAuth-Response-Type": "code",
    "X-Apple-OAuth-Response-Mode": "web_message",
    "X-Apple-OAuth-Client-Type": "firstPartyAuth",
  };
  if (context.scnt) {
    headers.scnt = context.scnt;
  }
  if (context.cookie) {
    headers.Cookie = context.cookie;
  }
  if (context.sessionId) {
    headers["X-Apple-ID-Session-Id"] = context.sessionId;
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function signInInit(
  accountName: string,
  srpA: bigint,
  context: IdmsaContext = EMPTY_IDMSA_CONTEXT,
): Promise<SignInInitResult> {
  const response = await loggedFetch("signInInit", `${IDMSA_BASE}/signin/init`, {
    method: "POST",
    headers: buildHeaders(context),
    body: JSON.stringify({
      a: Buffer.from(util.bytesFromBigint(srpA)).toString("base64"),
      accountName,
      protocols: ["s2k", "s2k_fo"],
    }),
  });

  const updatedContext = updateIdmsaContext(context, response.headers);
  const body = await readJsonBody(response);

  if (!response.ok || !isRecord(body)) {
    throw new Error(`SRP sign-in init failed (HTTP ${response.status}): ${JSON.stringify(body)}`);
  }

  const { salt, iteration, protocol, b, c } = body;
  if (
    typeof salt !== "string" ||
    typeof iteration !== "number" ||
    (protocol !== "s2k" && protocol !== "s2k_fo") ||
    typeof b !== "string" ||
    typeof c !== "string"
  ) {
    throw new Error(`SRP sign-in init returned an unexpected response shape: ${JSON.stringify(body)}`);
  }

  return {
    salt: new Uint8Array(Buffer.from(salt, "base64")),
    iterationCount: iteration,
    protocol,
    serverPublicValue: new Uint8Array(Buffer.from(b, "base64")),
    c,
    context: updatedContext,
  };
}

export async function signInComplete(
  accountName: string,
  m1: Uint8Array,
  m2: Uint8Array,
  c: string,
  trustTokens: readonly string[],
  context: IdmsaContext,
): Promise<SignInCompleteResult> {
  const response = await loggedFetch("signInComplete", `${IDMSA_BASE}/signin/complete?isRememberMeEnabled=true`, {
    method: "POST",
    headers: buildHeaders(context),
    body: JSON.stringify({
      accountName,
      trustTokens,
      m1: Buffer.from(m1).toString("base64"),
      m2: Buffer.from(m2).toString("base64"),
      c,
    }),
  });

  const updatedContext = updateIdmsaContext(context, response.headers);
  const sessionToken = response.headers.get("x-apple-session-token");

  if ((response.status === 200 || response.status === 409) && sessionToken) {
    return {
      status: response.status === 200 ? "trusted" : "needsTwoFactor",
      sessionToken,
      context: updatedContext,
      body: await readJsonBody(response),
    };
  }

  return {
    status: "unexpected",
    httpStatus: response.status,
    body: await readJsonBody(response),
    context: updatedContext,
  };
}

export async function submitTrustedDeviceCode(
  code: string,
  context: IdmsaContext,
): Promise<SubmitTrustedDeviceCodeResult> {
  const response = await loggedFetch("submitTrustedDeviceCode", `${IDMSA_BASE}/verify/trusteddevice/securitycode`, {
    method: "POST",
    headers: buildHeaders(context),
    body: JSON.stringify({ securityCode: { code } }),
  });

  const updatedContext = updateIdmsaContext(context, response.headers);

  if (response.status === 204) {
    return { status: "accepted", context: updatedContext };
  }
  if (response.status === 400) {
    return { status: "rejected", context: updatedContext };
  }
  return {
    status: "unexpected",
    httpStatus: response.status,
    body: await readJsonBody(response),
    context: updatedContext,
  };
}

/** GET /2sv/trust - only called once submitTrustedDeviceCode has already returned "accepted". */
export async function fetchTwoSvTrust(context: IdmsaContext): Promise<TwoSvTrustResult> {
  const response = await loggedFetch("fetchTwoSvTrust", `${IDMSA_BASE}/2sv/trust`, {
    method: "GET",
    headers: buildHeaders(context),
  });

  const trustToken = response.headers.get("x-apple-twosv-trust-token");
  const sessionToken = response.headers.get("x-apple-session-token");

  if (response.status !== 204 || !trustToken || !sessionToken) {
    throw new Error(
      `Failed to extend trust after 2FA (HTTP ${response.status}): missing trust/session token in response`,
    );
  }

  return { trustToken, sessionToken };
}
