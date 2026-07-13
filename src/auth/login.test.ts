import { test } from "node:test";
import assert from "node:assert/strict";
import { performLogin, type IdmsaOperations } from "./login.js";
import { EMPTY_IDMSA_CONTEXT } from "./idmsaContext.js";
import { DEFAULT_DEBUG_LOG_PATH } from "../debugLog.js";
import type {
  SignInInitResult,
  SignInCompleteResult,
  SubmitTrustedDeviceCodeResult,
  TwoSvTrustResult,
} from "./idmsaClient.js";

// Arbitrary-but-valid-shaped SRP inputs: real values matter for cryptographic
// correctness against Apple's server, but performLogin's branching logic only
// needs client.generate()/generateM2() to complete without throwing, which
// holds for any bytes that aren't (astronomically-unlikely) degenerate.
const FAKE_SALT = new Uint8Array(16).fill(3);
const FAKE_SERVER_PUBLIC_VALUE = new Uint8Array(32).fill(7);

function fakeSignInInitResult(): SignInInitResult {
  return {
    salt: FAKE_SALT,
    iterationCount: 1000,
    protocol: "s2k",
    serverPublicValue: FAKE_SERVER_PUBLIC_VALUE,
    c: "init-c-value",
    context: EMPTY_IDMSA_CONTEXT,
  };
}

function notCalled(name: string): () => never {
  return () => {
    throw new Error(`${name} should not have been called for this branch`);
  };
}

test("200 trusted: skips the code prompt and 2FA calls, keeps the existing trust token", async () => {
  let mintedToken: string | undefined;
  const ops: IdmsaOperations = {
    signInInit: async () => fakeSignInInitResult(),
    signInComplete: async (): Promise<SignInCompleteResult> => ({
      status: "trusted",
      sessionToken: "session-token-abc",
      context: EMPTY_IDMSA_CONTEXT,
      body: { authType: "hsa2" },
    }),
    submitTrustedDeviceCode: notCalled("submitTrustedDeviceCode"),
    fetchTwoSvTrust: notCalled("fetchTwoSvTrust"),
    mintIcloudSessionCookie: async (dsWebAuthToken: string) => {
      mintedToken = dsWebAuthToken;
      return "cookie=abc";
    },
  };

  const result = await performLogin(
    "user@example.com",
    "hunter2",
    "prior-trust-token",
    notCalled("promptForCode"),
    "build-1",
    "mastering-1",
    ops,
  );

  assert.equal(result.outcome, "success");
  assert.equal(mintedToken, "session-token-abc");
  if (result.outcome === "success") {
    assert.equal(result.session.cookie, "cookie=abc");
    assert.equal(result.session.trustToken, "prior-trust-token");
    assert.equal(result.session.clientBuildNumber, "build-1");
    assert.equal(result.session.clientMasteringNumber, "mastering-1");
  }
});

test("409 then accepted: prompts once, threads the session id into the 2FA call, returns the new trust token", async () => {
  let submittedCode: string | undefined;
  let submittedSessionId: string | undefined;
  let promptCalls = 0;

  const ops: IdmsaOperations = {
    signInInit: async () => fakeSignInInitResult(),
    signInComplete: async (): Promise<SignInCompleteResult> => ({
      status: "needsTwoFactor",
      sessionToken: "mfa-session-token",
      context: EMPTY_IDMSA_CONTEXT,
      body: { authType: "hsa2", trustedDeviceCount: 1 },
    }),
    submitTrustedDeviceCode: async (code, context): Promise<SubmitTrustedDeviceCodeResult> => {
      submittedCode = code;
      submittedSessionId = context.sessionId;
      return { status: "accepted", context };
    },
    fetchTwoSvTrust: async (): Promise<TwoSvTrustResult> => ({
      trustToken: "new-trust-token",
      sessionToken: "final-session-token",
    }),
    mintIcloudSessionCookie: async (dsWebAuthToken) => `cookie=${dsWebAuthToken}`,
  };

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message: string) => {
    loggedErrors.push(message);
  };

  let result;
  try {
    result = await performLogin(
      "user@example.com",
      "hunter2",
      undefined,
      async () => {
        promptCalls += 1;
        return "123456";
      },
      "build-1",
      "mastering-1",
      ops,
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(promptCalls, 1);
  assert.equal(submittedCode, "123456");
  // Confirms the X-Apple-ID-Session-Id wiring: it must come from signInComplete's
  // sessionToken, not be captured generically by updateIdmsaContext.
  assert.equal(submittedSessionId, "mfa-session-token");
  // The full signInComplete request/response (the only signal for why a push
  // notification didn't arrive) is written to the debug log by loggedFetch;
  // this just confirms the user is told where to look before the prompt.
  assert.ok(loggedErrors.some((message) => message.includes(DEFAULT_DEBUG_LOG_PATH)));
  assert.equal(result.outcome, "success");
  if (result.outcome === "success") {
    assert.equal(result.session.trustToken, "new-trust-token");
    assert.equal(result.session.cookie, "cookie=final-session-token");
  }
});

test("409 then rejected code: fails with a retry message, never calls fetchTwoSvTrust", async () => {
  const ops: IdmsaOperations = {
    signInInit: async () => fakeSignInInitResult(),
    signInComplete: async (): Promise<SignInCompleteResult> => ({
      status: "needsTwoFactor",
      sessionToken: "mfa-session-token",
      context: EMPTY_IDMSA_CONTEXT,
      body: { authType: "hsa2", trustedDeviceCount: 1 },
    }),
    submitTrustedDeviceCode: async (_code, context): Promise<SubmitTrustedDeviceCodeResult> => ({
      status: "rejected",
      context,
    }),
    fetchTwoSvTrust: notCalled("fetchTwoSvTrust"),
    mintIcloudSessionCookie: notCalled("mintIcloudSessionCookie"),
  };

  const result = await performLogin("user@example.com", "hunter2", undefined, async () => "000000", "build-1", "mastering-1", ops);

  assert.equal(result.outcome, "unsupportedTwoFactor");
  if (result.outcome === "unsupportedTwoFactor") {
    assert.match(result.detail, /rejected/i);
    assert.match(result.detail, /again/i);
  }
});

test("unexpected response at sign-in: fails before ever prompting for a code", async () => {
  const ops: IdmsaOperations = {
    signInInit: async () => fakeSignInInitResult(),
    signInComplete: async (): Promise<SignInCompleteResult> => ({
      status: "unexpected",
      httpStatus: 500,
      body: { foo: "bar" },
      context: EMPTY_IDMSA_CONTEXT,
    }),
    submitTrustedDeviceCode: notCalled("submitTrustedDeviceCode"),
    fetchTwoSvTrust: notCalled("fetchTwoSvTrust"),
    mintIcloudSessionCookie: notCalled("mintIcloudSessionCookie"),
  };

  const result = await performLogin(
    "user@example.com",
    "hunter2",
    undefined,
    notCalled("promptForCode"),
    "build-1",
    "mastering-1",
    ops,
  );

  assert.equal(result.outcome, "unsupportedTwoFactor");
  if (result.outcome === "unsupportedTwoFactor") {
    assert.match(result.detail, /sign-in/);
    assert.match(result.detail, /500/);
    assert.match(result.detail, /github.com/);
  }
});

test("unexpected response at 2FA code submission: fails citing that stage", async () => {
  const ops: IdmsaOperations = {
    signInInit: async () => fakeSignInInitResult(),
    signInComplete: async (): Promise<SignInCompleteResult> => ({
      status: "needsTwoFactor",
      sessionToken: "mfa-session-token",
      context: EMPTY_IDMSA_CONTEXT,
      body: { authType: "hsa2", trustedDeviceCount: 1 },
    }),
    submitTrustedDeviceCode: async (_code, context): Promise<SubmitTrustedDeviceCodeResult> => ({
      status: "unexpected",
      httpStatus: 503,
      body: null,
      context,
    }),
    fetchTwoSvTrust: notCalled("fetchTwoSvTrust"),
    mintIcloudSessionCookie: notCalled("mintIcloudSessionCookie"),
  };

  const result = await performLogin("user@example.com", "hunter2", undefined, async () => "123456", "build-1", "mastering-1", ops);

  assert.equal(result.outcome, "unsupportedTwoFactor");
  if (result.outcome === "unsupportedTwoFactor") {
    assert.match(result.detail, /2FA code submission/);
    assert.match(result.detail, /503/);
  }
});
