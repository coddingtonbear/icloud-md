import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  buildIcloudCookieHeader,
  extractClientParams,
  isFullySignedInBody,
  isIcloudDomain,
  isMissingChromiumError,
  launchWithLazyChromiumInstall,
  resolveBrowserExecutable,
  resolvePlaywrightCli,
  sessionFromBrowserCapture,
  type CapturedCookie,
} from "./browserLogin.js";
import { BrowserExecutableLaunchError, ChromiumNotInstalledError, InvalidBrowserExecutableError } from "../errors.js";
import type { BrowserContext } from "playwright";
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

test("isMissingChromiumError matches Playwright's own missing-executable message", () => {
  assert.equal(
    isMissingChromiumError(new Error("Executable doesn't exist at /home/user/.cache/ms-playwright/chromium-1234/chrome")),
    true,
  );
});

test("isMissingChromiumError rejects other launch failures and non-Error values", () => {
  assert.equal(isMissingChromiumError(new Error("spawn EACCES")), false);
  assert.equal(isMissingChromiumError("Executable doesn't exist"), false);
  assert.equal(isMissingChromiumError(undefined), false);
});

test("resolvePlaywrightCli points at the installed playwright package's real CLI entrypoint", () => {
  const cli = resolvePlaywrightCli();
  assert.equal(path.isAbsolute(cli), true);
  assert.equal(path.basename(cli), "cli.js");
  // Would fail if a playwright upgrade moved/renamed its bin target - the
  // lazy-install path would then break only on fresh machines, so catch it here.
  assert.equal(existsSync(cli), true);
});

test("resolveBrowserExecutable defaults to the bundled browser, and the explicit value beats the environment", () => {
  assert.equal(resolveBrowserExecutable(undefined, {}), undefined);
  assert.equal(resolveBrowserExecutable(undefined, { ICLOUD_MD_BROWSER_EXECUTABLE: "/env/chromium" }), "/env/chromium");
  assert.equal(
    resolveBrowserExecutable("/flag/chromium", { ICLOUD_MD_BROWSER_EXECUTABLE: "/env/chromium" }),
    "/flag/chromium",
  );
});

test("resolveBrowserExecutable refuses empty and non-absolute values rather than falling back to the bundled browser", () => {
  for (const value of ["", " ", "chromium", "./chrome"]) {
    assert.throws(() => resolveBrowserExecutable(value, {}), InvalidBrowserExecutableError);
    assert.throws(
      () => resolveBrowserExecutable(undefined, { ICLOUD_MD_BROWSER_EXECUTABLE: value }),
      InvalidBrowserExecutableError,
    );
  }
});

const fakeContext = {} as BrowserContext;
const missingExecutable = () => new Error("Executable doesn't exist at /home/user/.cache/ms-playwright/chromium/chrome");

test("without a chosen browser, launch passes no executablePath and installs only on a missing executable", async () => {
  const launches: Array<string | undefined> = [];
  let installs = 0;
  const context = await launchWithLazyChromiumInstall("/profile", false, () => {}, undefined, {
    launch: async (_profile, options) => {
      launches.push(options?.executablePath);
      if (launches.length === 1) {
        throw missingExecutable();
      }
      return fakeContext;
    },
    install: async () => {
      installs++;
    },
  });
  assert.equal(context, fakeContext);
  assert.deepEqual(launches, [undefined, undefined]);
  assert.equal(installs, 1);
});

test("a chosen browser is launched with icloud-md's own profile, and a failure never downloads or falls back", async () => {
  let installs = 0;
  const launched = await launchWithLazyChromiumInstall("/dedicated/profile", true, () => {}, "/usr/bin/chromium", {
    launch: async (profile, options) => {
      assert.equal(profile, "/dedicated/profile");
      assert.equal(options?.executablePath, "/usr/bin/chromium");
      assert.equal(options?.headless, true);
      return fakeContext;
    },
    install: async () => {
      installs++;
    },
  });
  assert.equal(launched, fakeContext);

  let launches = 0;
  await assert.rejects(
    launchWithLazyChromiumInstall("/profile", false, () => {}, "/usr/bin/chromium", {
      launch: async () => {
        launches++;
        throw missingExecutable();
      },
      install: async () => {
        installs++;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserExecutableLaunchError);
      assert.match(error.message, /\/usr\/bin\/chromium: Executable doesn't exist/);
      return true;
    },
  );
  assert.equal(launches, 1);
  assert.equal(installs, 0);
});

test("a failed bundled install still surfaces as ChromiumNotInstalledError, pointing at install-browser", async () => {
  await assert.rejects(
    launchWithLazyChromiumInstall("/profile", false, () => {}, undefined, {
      launch: async () => {
        throw missingExecutable();
      },
      install: async () => {
        throw new Error("download failed");
      },
    }),
    (error: unknown) => error instanceof ChromiumNotInstalledError && /install-browser/.test(error.hint ?? ""),
  );
});
