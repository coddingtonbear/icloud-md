import { access, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext } from "playwright";
import { BrowserLaunchError, ChromiumNotInstalledError, IcloudNotesSyncError } from "../errors.js";
import { diagnosticMessage, redactDiagnostic } from "../errorDiagnostics.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
export const BROWSER_EXECUTABLE_ENV = "ICLOUD_MD_BROWSER_EXECUTABLE";

export interface BrowserSelection {
  source: "bundled" | "option" | "environment";
  executablePath?: string;
}

/** Explicit option wins over the environment; no override keeps Playwright's
 * version-matched browser. Require a path, not a shell command or PATH lookup. */
export function resolveBrowserSelection(
  executable?: string,
  env: NodeJS.ProcessEnv = process.env,
): BrowserSelection {
  const value = executable ?? env[BROWSER_EXECUTABLE_ENV];
  if (value === undefined) return { source: "bundled" };
  if (!value.trim() || !path.isAbsolute(value)) {
    throw new IcloudNotesSyncError("The browser executable must be a non-empty absolute path.", {
      hint: `Use --browser-executable <path> or ${BROWSER_EXECUTABLE_ENV}; do not include browser arguments.`,
    });
  }
  return { source: executable !== undefined ? "option" : "environment", executablePath: value };
}

export function resolvePlaywrightCli(): string {
  return path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
}

/** Use this installation's CLI, never npx (which may install a different version). */
export async function installChromium(
  status: (message: string) => void = () => {},
  run: (file: string, args: string[], options: { maxBuffer: number; env: NodeJS.ProcessEnv }) =>
    Promise<{ stdout: string; stderr: string }> = execFileAsync,
): Promise<void> {
  try {
    const { stdout, stderr } = await run(process.execPath, [resolvePlaywrightCli(), "install", "chromium"], {
      maxBuffer: 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const output = redactDiagnostic(`${stdout}\n${stderr}`).trim();
    if (output) status(output);
  } catch (cause) {
    // execFile's own message includes stderr; stdout can carry the download's
    // actual failure too. Bound saved output, and never serialize child env.
    const output = cause as { stdout?: string; stderr?: string };
    const detail = redactDiagnostic(`${diagnosticMessage(cause)}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`);
    throw new BrowserLaunchError("installation", detail.slice(0, 16_384));
  }
}

export function isMissingChromiumError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Executable doesn't exist");
}

/** Only classify signatures with a clear meaning. Unknown errors retain their
 * identity and stack rather than being mislabeled as installation failures. */
export function classifyBrowserError(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause;
  const message = cause.message;
  if (isMissingChromiumError(cause)) return new ChromiumNotInstalledError({ cause });
  if (/Missing X server or \$DISPLAY|cannot open display|Failed to connect to.*Wayland|Failed to initialize.*Ozone/i.test(message)) {
    return new BrowserLaunchError("display", undefined, { cause });
  }
  if (/Host system is missing dependencies|error while loading shared libraries|cannot open shared object file/i.test(message)) {
    return new BrowserLaunchError("dependencies", undefined, { cause });
  }
  if (/No usable sandbox|Running as root without --no-sandbox|Failed to move to new namespace|SUID sandbox helper binary.*not configured/i.test(message)) {
    return new BrowserLaunchError("sandbox", undefined, { cause });
  }
  if (/ERR_CERT_[A-Z_]+|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|unable to get local issuer certificate/i.test(message)) {
    return new BrowserLaunchError("certificate", undefined, { cause });
  }
  return cause;
}

interface LaunchDeps {
  launch?: typeof chromium.launchPersistentContext;
  install?: typeof installChromium;
}

export async function launchLoginBrowser(
  profileDir: string,
  headless: boolean,
  status: (message: string) => void,
  selection: BrowserSelection,
  deps: LaunchDeps = {},
): Promise<BrowserContext> {
  const launch = deps.launch ?? chromium.launchPersistentContext.bind(chromium);
  const install = deps.install ?? installChromium;
  if (selection.executablePath !== undefined) {
    try {
      await access(selection.executablePath, constants.X_OK);
      if (!(await stat(selection.executablePath)).isFile()) throw new Error("Path is not a regular file.");
    } catch (cause) {
      throw new BrowserLaunchError("executable", `Selected path: ${selection.executablePath}`, { cause });
    }
  }
  const options = {
    headless,
    viewport: null,
    chromiumSandbox: true,
    ignoreHTTPSErrors: false,
    ...(selection.executablePath !== undefined ? { executablePath: selection.executablePath } : {}),
  };
  try {
    return await launch(profileDir, options);
  } catch (cause) {
    if (selection.source !== "bundled" || !isMissingChromiumError(cause)) {
      // An explicit choice never triggers an install or another browser.
      if (selection.source !== "bundled" && isMissingChromiumError(cause)) {
        throw new BrowserLaunchError("executable", undefined, { cause });
      }
      throw classifyBrowserError(cause);
    }
  }
  status("First-time setup: downloading the sign-in browser (~150MB, one-time)...");
  try {
    await install(status);
  } catch (cause) {
    if (cause instanceof BrowserLaunchError) throw cause;
    throw new BrowserLaunchError("installation", undefined, { cause });
  }
  try {
    return await launch(profileDir, options);
  } catch (cause) {
    throw classifyBrowserError(cause);
  }
}

/** Read-only preflight: no profile, browser launch, download, or iCloud request. */
export async function browserInfo(selection: BrowserSelection, env: NodeJS.ProcessEnv = process.env) {
  const executablePath = selection.executablePath ?? chromium.executablePath();
  const names = process.platform === "win32" ? ["chrome.exe", "msedge.exe"] :
    ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"];
  const candidates = (env.PATH ?? "").split(path.delimiter).filter(Boolean)
    .flatMap((dir) => names.map((name) => path.resolve(dir, name)));
  if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  }
  const available: string[] = [];
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) available.push(candidate);
    } catch { /* Not an installed executable. */ }
  }
  return {
    source: selection.source,
    executablePath,
    exists: existsSync(executablePath),
    playwrightVersion: (require("playwright/package.json") as { version: string }).version,
    installerPath: resolvePlaywrightCli(),
    sandbox: true,
    certificateVerification: true,
    display: Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"]
      .map((key) => [key, env[key] ?? null])),
    systemBrowserCandidates: available,
  };
}
