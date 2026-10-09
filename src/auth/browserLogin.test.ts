import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertBrowserExecutable,
  buildIcloudCookieHeader,
  extractClientParams,
  isFullySignedInBody,
  isIcloudDomain,
  isMissingChromiumError,
  launchWithLazyChromiumInstall,
  performBrowserLogin,
  resolveBrowserExecutable,
  resolvePlaywrightCli,
  sessionFromBrowserCapture,
  type CapturedCookie,
} from "./browserLogin.js";
import {
  BrowserExecutableLaunchError,
  BrowserExecutableNotFoundError,
  ChromiumNotInstalledError,
  InvalidBrowserExecutableError,
} from "../errors.js";
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

const accept = () => {};

test("resolveBrowserExecutable defaults to the bundled browser, and the explicit value beats the environment", () => {
  assert.equal(resolveBrowserExecutable(undefined, {}, accept), undefined);
  assert.equal(
    resolveBrowserExecutable(undefined, { ICLOUD_MD_BROWSER_EXECUTABLE: "/env/chromium" }, accept),
    "/env/chromium",
  );
  assert.equal(
    resolveBrowserExecutable("/flag/chromium", { ICLOUD_MD_BROWSER_EXECUTABLE: "/env/chromium" }, accept),
    "/flag/chromium",
  );
});

test("resolveBrowserExecutable refuses empty and non-absolute values rather than falling back to the bundled browser", () => {
  for (const value of ["", " ", "chromium", "./chrome"]) {
    assert.throws(() => resolveBrowserExecutable(value, {}, accept), InvalidBrowserExecutableError);
    assert.throws(
      () => resolveBrowserExecutable(undefined, { ICLOUD_MD_BROWSER_EXECUTABLE: value }, accept),
      InvalidBrowserExecutableError,
    );
  }
});

test("resolveBrowserExecutable checks the file is really there, whichever source named it", () => {
  const verified: string[] = [];
  const verify = (executablePath: string) => {
    verified.push(executablePath);
    throw new BrowserExecutableNotFoundError(executablePath, "does not exist");
  };
  assert.throws(() => resolveBrowserExecutable("/flag/chromium", {}, verify), BrowserExecutableNotFoundError);
  assert.throws(
    () => resolveBrowserExecutable(undefined, { ICLOUD_MD_BROWSER_EXECUTABLE: "/env/chromium" }, verify),
    BrowserExecutableNotFoundError,
  );
  assert.deepEqual(verified, ["/flag/chromium", "/env/chromium"]);
});

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "icloud-md-browser-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("assertBrowserExecutable says which of missing, directory, or non-executable the path is", () =>
  withTempDir(async (dir) => {
    const missing = path.join(dir, "chromium");
    assert.throws(() => assertBrowserExecutable(missing), (error: unknown) => {
      assert.ok(error instanceof BrowserExecutableNotFoundError);
      assert.equal(error.message, `The browser executable ${missing} does not exist.`);
      assert.match(error.hint ?? "", /--browser-executable/);
      return true;
    });

    assert.throws(() => assertBrowserExecutable(dir), new RegExp(`${dir} is not a file`));

    const script = path.join(dir, "chrome");
    await writeFile(script, "#!/bin/sh\n");
    await chmod(script, 0o600);
    if (process.getuid?.() !== 0) {
      // root can execute anything, so the mode bits only mean something for everyone else.
      assert.throws(() => assertBrowserExecutable(script), /is not executable/);
    }
    await chmod(script, 0o700);
    assert.doesNotThrow(() => assertBrowserExecutable(script));
    assert.equal(resolveBrowserExecutable(script, {}), script);
  }));

test("performBrowserLogin launches the executable from its option, else from the environment, with icloud-md's own profile", () =>
  withTempDir(async (dir) => {
    const launches: Array<string | undefined> = [];
    const deps = {
      launch: async (profile: string, options?: { executablePath?: string }) => {
        assert.equal(profile, path.join(dir, "profile"));
        launches.push(options?.executablePath);
        throw new Error("stop here - the launch is all this test is after");
      },
      install: async () => {
        throw new Error("never downloads when an executable is chosen");
      },
    };
    const executable = path.join(dir, "chrome");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o700);

    const profileDir = path.join(dir, "profile");
    await assert.rejects(
      performBrowserLogin({ profileDir, executablePath: executable }, deps),
      BrowserExecutableLaunchError,
    );

    const previous = process.env.ICLOUD_MD_BROWSER_EXECUTABLE;
    process.env.ICLOUD_MD_BROWSER_EXECUTABLE = executable;
    try {
      await assert.rejects(performBrowserLogin({ profileDir }, deps), BrowserExecutableLaunchError);
    } finally {
      if (previous === undefined) {
        delete process.env.ICLOUD_MD_BROWSER_EXECUTABLE;
      } else {
        process.env.ICLOUD_MD_BROWSER_EXECUTABLE = previous;
      }
    }

    assert.deepEqual(launches, [executable, executable]);
  }));

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
