import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIcloudCookieHeader,
  extractClientParams,
  isFullySignedInBody,
  isIcloudDomain,
  sessionFromBrowserCapture,
  type CapturedCookie,
} from "./browserLogin.js";
import { DEFAULT_CLIENT_BUILD_NUMBER, DEFAULT_CLIENT_MASTERING_NUMBER } from "./clientConstants.js";

const ACCOUNT_LOGIN_URL =
  "https://setup.icloud.com/setup/ws/1/accountLogin?clientBuildNumber=2624Build99&clientMasteringNumber=2624Build99&clientId=11111111-2222-3333-4444-555555555555";

test("isIcloudDomain matches icloud.com and subdomains, with or without a leading dot", () => {
  assert.equal(isIcloudDomain(".icloud.com"), true);
  assert.equal(isIcloudDomain("icloud.com"), true);
  assert.equal(isIcloudDomain("setup.icloud.com"), true);
  assert.equal(isIcloudDomain("www.icloud.com"), true);
});

test("isIcloudDomain rejects other domains, including lookalike suffixes", () => {
  assert.equal(isIcloudDomain("idmsa.apple.com"), false);
  assert.equal(isIcloudDomain(".apple.com"), false);
  assert.equal(isIcloudDomain("notreallyicloud.com"), false);
});

test("buildIcloudCookieHeader forwards the whole icloud.com jar and drops everything else", () => {
  const cookies: CapturedCookie[] = [
    { name: "X-APPLE-WEBAUTH-TOKEN", value: "v=2:t=abc", domain: ".icloud.com" },
    { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "session123", domain: ".icloud.com" },
    { name: "aasp", value: "idmsa-only", domain: "idmsa.apple.com" },
    { name: "X-APPLE-WEB-ID", value: "webid", domain: "www.icloud.com" },
  ];
  assert.equal(
    buildIcloudCookieHeader(cookies),
    "X-APPLE-WEBAUTH-TOKEN=v=2:t=abc; X-APPLE-DS-WEB-SESSION-TOKEN=session123; X-APPLE-WEB-ID=webid",
  );
});

test("extractClientParams pulls the client identifiers off a setup request URL", () => {
  assert.deepEqual(extractClientParams(ACCOUNT_LOGIN_URL), {
    clientId: "11111111-2222-3333-4444-555555555555",
    clientBuildNumber: "2624Build99",
    clientMasteringNumber: "2624Build99",
  });
});

test("extractClientParams returns undefined for params the URL lacks", () => {
  assert.deepEqual(extractClientParams("https://setup.icloud.com/setup/ws/1/validate?requestId=x"), {
    clientId: undefined,
    clientBuildNumber: undefined,
    clientMasteringNumber: undefined,
  });
});

test("sessionFromBrowserCapture assembles a session from the jar and observed client params", () => {
  const capturedAt = new Date("2026-07-13T12:00:00.000Z");
  const session = sessionFromBrowserCapture(
    [{ name: "X-APPLE-WEBAUTH-TOKEN", value: "tok", domain: ".icloud.com" }],
    ACCOUNT_LOGIN_URL,
    capturedAt,
  );
  assert.deepEqual(session, {
    cookie: "X-APPLE-WEBAUTH-TOKEN=tok",
    clientId: "11111111-2222-3333-4444-555555555555",
    clientBuildNumber: "2624Build99",
    clientMasteringNumber: "2624Build99",
    capturedAt: "2026-07-13T12:00:00.000Z",
  });
});

test("sessionFromBrowserCapture falls back to default client params and a generated clientId", () => {
  const session = sessionFromBrowserCapture(
    [{ name: "X-APPLE-WEBAUTH-TOKEN", value: "tok", domain: ".icloud.com" }],
    "https://setup.icloud.com/setup/ws/1/validate",
  );
  assert.equal(session.clientBuildNumber, DEFAULT_CLIENT_BUILD_NUMBER);
  assert.equal(session.clientMasteringNumber, DEFAULT_CLIENT_MASTERING_NUMBER);
  assert.match(session.clientId, /^[0-9a-f-]{36}$/);
});

test("sessionFromBrowserCapture refuses a jar with no icloud.com cookies at all", () => {
  assert.throws(
    () => sessionFromBrowserCapture([{ name: "aasp", value: "x", domain: "idmsa.apple.com" }], ACCOUNT_LOGIN_URL),
    /no icloud\.com cookies/,
  );
});

test("isFullySignedInBody accepts a completed sign-in response", () => {
  // Shape of the HAR's second (post-2FA) accountLogin: no hsaChallengeRequired.
  assert.equal(
    isFullySignedInBody({
      dsInfo: { appleId: "me@example.com", dsid: "1234", hsaVersion: 2 },
      webservices: { ckdatabasews: { url: "https://p43-ckdatabasews.icloud.com:443" } },
    }),
    true,
  );
});

test("isFullySignedInBody rejects the partial pre-2FA accountLogin response", () => {
  // Shape of the HAR's first accountLogin: HTTP 200, but 2FA still pending.
  // It even includes ckdatabasews, so the challenge flag is the only tell.
  assert.equal(
    isFullySignedInBody({
      hsaChallengeRequired: true,
      dsInfo: { appleId: "me@example.com", dsid: "1234", hsaVersion: 2 },
      webservices: { ckdatabasews: { url: "https://p43-ckdatabasews.icloud.com:443" } },
    }),
    false,
  );
});

test("isFullySignedInBody rejects a challenge flag nested under dsInfo", () => {
  assert.equal(
    isFullySignedInBody({ dsInfo: { appleId: "x", dsid: "1", hsaChallengeRequired: true } }),
    false,
  );
});

test("isFullySignedInBody rejects bodies without account info", () => {
  assert.equal(isFullySignedInBody(null), false);
  assert.equal(isFullySignedInBody({}), false);
  assert.equal(isFullySignedInBody({ success: true }), false);
});
