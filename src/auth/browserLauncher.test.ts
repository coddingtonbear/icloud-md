import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { chromium, type BrowserContext } from "playwright";
import { browserInfo, classifyBrowserError, installChromium, launchLoginBrowser, resolveBrowserSelection, resolvePlaywrightCli } from "./browserLauncher.js";
import { performBrowserLogin } from "./browserLogin.js";
import { BrowserLaunchError, ChromiumNotInstalledError } from "../errors.js";

test("browser selection defaults to bundled and explicit option wins over environment", () => {
  assert.deepEqual(resolveBrowserSelection(undefined, {}), { source: "bundled" });
  assert.deepEqual(resolveBrowserSelection(undefined, { ICLOUD_MD_BROWSER_EXECUTABLE: "/env/chrome" }), {
    source: "environment", executablePath: "/env/chrome",
  });
  assert.deepEqual(resolveBrowserSelection("/option/chrome", { ICLOUD_MD_BROWSER_EXECUTABLE: "/env/chrome" }), {
    source: "option", executablePath: "/option/chrome",
  });
});

test("invalid configured paths never silently become the bundled default", () => {
  for (const value of ["", " ", "chromium", "./chrome"]) {
    assert.throws(() => resolveBrowserSelection(value, {}), /absolute path/);
    assert.throws(() => resolveBrowserSelection(undefined, { ICLOUD_MD_BROWSER_EXECUTABLE: value }), /absolute path/);
  }
});

const context = {} as BrowserContext;
const missing = () => new Error("Executable doesn't exist at /bundled/chrome");

test("default launch preserves the dedicated profile and enables sandbox and TLS verification", async () => {
  let installs = 0;
  const result = await launchLoginBrowser("/dedicated/profile", false, () => {}, { source: "bundled" }, {
    launch: async (profile, opts) => {
      assert.equal(profile, "/dedicated/profile");
      assert.deepEqual(opts, { headless: false, viewport: null, chromiumSandbox: true, ignoreHTTPSErrors: false });
      return context;
    },
    install: async () => { installs++; },
  });
  assert.equal(result, context);
  assert.equal(installs, 0);
});

test("only missing bundled executable triggers installation followed by one retry", async () => {
  let launches = 0, installs = 0;
  await launchLoginBrowser("/profile", true, () => {}, { source: "bundled" }, {
    launch: async (_profile, opts) => {
      assert.equal(opts?.headless, true);
      if (++launches === 1) throw missing();
      return context;
    },
    install: async () => { installs++; },
  });
  assert.equal(launches, 2);
  assert.equal(installs, 1);
});

test("failed install keeps its cause and does not retry launch", async () => {
  const cause = new Error("Download failed: 503 Site Unavailable");
  let launches = 0;
  await assert.rejects(launchLoginBrowser("/profile", false, () => {}, { source: "bundled" }, {
    launch: async () => { launches++; throw missing(); },
    install: async () => { throw cause; },
  }), (error: unknown) => {
    assert.ok(error instanceof BrowserLaunchError);
    assert.equal(error.reason, "installation");
    assert.equal(error.cause, cause);
    assert.match(error.hint!, /icloud-md install-browser/);
    return true;
  });
  assert.equal(launches, 1);
});

test("missing executable after successful install is reported without an install loop", async () => {
  let installs = 0;
  await assert.rejects(launchLoginBrowser("/profile", false, () => {}, { source: "bundled" }, {
    launch: async () => { throw missing(); }, install: async () => { installs++; },
  }), ChromiumNotInstalledError);
  assert.equal(installs, 1);
});

test("explicit executable is honored with the dedicated profile, and never installs after launch failure", async () => {
  let installs = 0;
  const cause = new Error("spawn EACCES");
  for (const fail of [false, true]) {
    const launch = launchLoginBrowser("/dedicated/profile", false, () => {},
      resolveBrowserSelection(process.execPath, {}), {
        launch: async (profile, opts) => {
          assert.equal(profile, "/dedicated/profile");
          assert.equal(opts?.executablePath, process.execPath);
          assert.equal(opts?.chromiumSandbox, true);
          if (fail) throw cause;
          return context;
        },
        install: async () => { installs++; },
      });
    if (fail) await assert.rejects(launch, (e) => e === cause);
    else assert.equal(await launch, context);
  }
  assert.equal(installs, 0);
});

test("missing, non-executable, and directory overrides fail before launch or install", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "browser-path-test-"));
  try {
    const nonExecutable = path.join(dir, "chrome");
    await writeFile(nonExecutable, "not a browser", { mode: 0o600 });
    await chmod(nonExecutable, 0o600);
    const paths = [path.join(dir, "missing"), dir];
    if (process.platform !== "win32") paths.push(nonExecutable);
    for (const executable of paths) {
      await assert.rejects(launchLoginBrowser("/profile", false, () => {}, resolveBrowserSelection(executable, {}), {
        launch: async () => { assert.fail("must not launch"); },
        install: async () => { assert.fail("must not install"); },
      }), (e: unknown) => e instanceof BrowserLaunchError && e.reason === "executable");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [message, reason] of [
  ["Missing X server or $DISPLAY", "display"],
  ["Failed to connect to Wayland display", "display"],
  ["Host system is missing dependencies to run browsers", "dependencies"],
  ["error while loading shared libraries: libnss3.so: cannot open shared object file", "dependencies"],
  ["No usable sandbox!", "sandbox"],
  ["Running as root without --no-sandbox is not supported", "sandbox"],
  ["Failed to move to new namespace: Operation not permitted", "sandbox"],
  ["page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://www.icloud.com/", "certificate"],
]) {
  test(`classifies ${reason}: ${message}, with no installer or insecure retry`, async () => {
    const cause = new Error(message);
    const error = classifyBrowserError(cause);
    assert.ok(error instanceof BrowserLaunchError);
    assert.equal(error.reason, reason);
    assert.equal(error.cause, cause);
    let launches = 0;
    await assert.rejects(launchLoginBrowser("/profile", false, () => {}, { source: "bundled" }, {
      launch: async () => { launches++; throw cause; },
      install: async () => { assert.fail("must not install"); },
    }), BrowserLaunchError);
    assert.equal(launches, 1);
  });
}

test("unknown failures preserve their original identity", () => {
  const error = new TypeError("Something unexpected happened");
  assert.equal(classifyBrowserError(error), error);
  assert.equal(classifyBrowserError("non-Error failure"), "non-Error failure");
});

test("diagnostics list candidates but do not select them or need an account", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "browser-info-test-"));
  try {
    const candidate = path.join(dir, process.platform === "win32" ? "chrome.exe" : "chromium");
    await writeFile(candidate, "test fixture", { mode: 0o700 });
    const info = await browserInfo({ source: "bundled" }, { PATH: dir, DISPLAY: ":5" });
    assert.equal(info.source, "bundled");
    assert.notEqual(info.executablePath, candidate);
    assert.ok(info.systemBrowserCandidates.includes(candidate));
    assert.equal(info.display.DISPLAY, ":5");
    assert.equal(info.display.WAYLAND_DISPLAY, null);
    assert.match(info.playwrightVersion, /^\d+\.\d+\.\d+/);
    const selected = await browserInfo(resolveBrowserSelection(candidate, {}), { PATH: "" });
    assert.equal(selected.executablePath, candidate);
    assert.equal(selected.exists, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("certificate navigation failure closes the context without an unhandled sign-in rejection", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "browser-navigation-test-"));
  const fake = new EventEmitter();
  let closed = false;
  const mockContext = Object.assign(fake, {
    pages: () => [{ goto: async () => { throw new Error("net::ERR_CERT_AUTHORITY_INVALID"); } }],
    close: async () => { closed = true; fake.emit("close"); },
  }) as unknown as BrowserContext;
  t.mock.method(chromium, "launchPersistentContext", async () => mockContext);
  try {
    await assert.rejects(performBrowserLogin({ profileDir: dir, browserExecutable: process.execPath }),
      (e: unknown) => e instanceof BrowserLaunchError && e.reason === "certificate");
    assert.equal(closed, true);
    assert.equal(fake.listenerCount("response"), 0);
    await new Promise((resolve) => setImmediate(resolve));
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("installer invokes this dependency's CLI with this Node, not npx or the working directory", async () => {
  const messages: string[] = [];
  await installChromium((message) => messages.push(message), async (file, args) => {
    assert.equal(file, process.execPath);
    assert.deepEqual(args, [resolvePlaywrightCli(), "install", "chromium"]);
    assert.ok(path.isAbsolute(args[0]!));
    return { stdout: "Downloaded Chromium", stderr: "" };
  });
  assert.match(messages.join(""), /Downloaded Chromium/);
});

test("installer output is redacted in both success status and failure diagnostics", async () => {
  const raw = "Download failed: Site Unavailable https://proxy.test/archive?token=download-secret\nCookie: session=cookie-secret";
  const messages: string[] = [];
  await installChromium((message) => messages.push(message), async () => ({ stdout: raw, stderr: "" }));
  assert.doesNotMatch(messages.join(""), /download-secret|cookie-secret/);
  await assert.rejects(installChromium(() => {}, async () => {
    throw Object.assign(new Error("installer exited with code 1"), { stdout: raw, stderr: "bad archive" });
  }), (e: unknown) => {
    assert.ok(e instanceof BrowserLaunchError);
    assert.equal(e.reason, "installation");
    assert.match(e.message, /Site Unavailable/);
    assert.match(e.message, /bad archive/);
    assert.doesNotMatch(e.message, /download-secret|cookie-secret/);
    return true;
  });
});
