import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { DEFAULT_CLIENT_BUILD_NUMBER, DEFAULT_CLIENT_MASTERING_NUMBER } from "./clientConstants.js";
import type { IcloudSession } from "../session.js";

/**
 * Browser-driven login: open a real (headed) browser window on www.icloud.com,
 * let the user - and Apple's own JavaScript - do the entire sign-in dance
 * (password, whatever 2FA variant the account uses, CAPTCHAs, interstitials),
 * then harvest the resulting session cookies once the page's own
 * setup.icloud.com bootstrap call succeeds.
 *
 * This deliberately owns none of the idmsa.apple.com protocol surface: Apple's
 * pages execute whatever this month's login flow is, and all we depend on is
 * the shape of the *result* (a cookie jar for .icloud.com plus the client
 * query params), which is the same thing the HAR-import path already proved
 * sufficient.
 */

/**
 * The login browser's own persistent state (cookies, local storage, and the
 * device trust Apple grants after a completed 2FA). Reusing one profile means
 * repeat logins look like a returning browser and typically skip 2FA entirely.
 */
export const DEFAULT_BROWSER_PROFILE_DIR = path.join(os.homedir(), ".config", "icloud-notes-sync", "browser-profile");

const ICLOUD_HOME = "https://www.icloud.com/";

/**
 * The web client calls /validate on page load (200 only with a live session)
 * and /accountLogin as the final step of an interactive sign-in. A 2xx on
 * either means the session cookies in the browser's jar are now valid, whether
 * the user just signed in or the persistent profile was still logged in.
 */
const SETUP_SUCCESS_PATTERN = /^https:\/\/setup\.icloud\.com\/setup\/ws\/1\/(accountLogin|validate)(\?|$)/;

/** The subset of Playwright's cookie shape the capture logic needs. */
export interface CapturedCookie {
  name: string;
  value: string;
  domain: string;
}

/** True for icloud.com and any subdomain, with or without a leading dot. */
export function isIcloudDomain(domain: string): boolean {
  const host = domain.replace(/^\./, "");
  return host === "icloud.com" || host.endsWith(".icloud.com");
}

/**
 * Builds the verbatim Cookie header the rest of the client sends to
 * setup.icloud.com/ckdatabasews. Mirrors the HAR-import approach: forward the
 * whole icloud.com jar rather than guessing which cookies matter (see the
 * open question in the dev notes about which ones are actually required).
 */
export function buildIcloudCookieHeader(cookies: readonly CapturedCookie[]): string {
  return cookies
    .filter((cookie) => isIcloudDomain(cookie.domain))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export interface ClientParams {
  clientId: string | undefined;
  clientBuildNumber: string | undefined;
  clientMasteringNumber: string | undefined;
}

/** Pulls the web client's identifying query params off a setup.icloud.com request URL. */
export function extractClientParams(url: string): ClientParams {
  const params = new URL(url).searchParams;
  return {
    clientId: params.get("clientId") ?? undefined,
    clientBuildNumber: params.get("clientBuildNumber") ?? undefined,
    clientMasteringNumber: params.get("clientMasteringNumber") ?? undefined,
  };
}

/**
 * Assembles an IcloudSession from a captured cookie jar and the setup call's
 * URL. Client params come from the observed request itself (so they track
 * whatever web-client build actually just logged in) with the static defaults
 * as fallback. Device trust lives in the persistent browser profile, not the
 * session file.
 */
export function sessionFromBrowserCapture(
  cookies: readonly CapturedCookie[],
  setupRequestUrl: string,
  capturedAt: Date = new Date(),
): IcloudSession {
  const cookie = buildIcloudCookieHeader(cookies);
  if (cookie === "") {
    throw new Error("The browser session contained no icloud.com cookies to capture - sign-in did not complete.");
  }

  const params = extractClientParams(setupRequestUrl);
  return {
    cookie,
    clientId: params.clientId ?? crypto.randomUUID(),
    clientBuildNumber: params.clientBuildNumber ?? DEFAULT_CLIENT_BUILD_NUMBER,
    clientMasteringNumber: params.clientMasteringNumber ?? DEFAULT_CLIENT_MASTERING_NUMBER,
    capturedAt: capturedAt.toISOString(),
  };
}

export interface BrowserLoginOptions {
  profileDir?: string;
  onStatus?: (message: string) => void;
  /**
   * Run without a visible window. Only meaningful for the persistent profile:
   * a profile Apple already trusts can sometimes complete sign-in with no
   * interaction at all (the same silent recovery a live browser tab performs
   * after its own session lapses - see the 2026-07-13 dev notes). A profile
   * that actually needs a human (fresh 2FA, CAPTCHA) will just sit waiting
   * with nothing able to click through it, so headless callers should also
   * pass `timeoutMs`. Defaults to `false` (the interactive `login` command).
   */
  headless?: boolean;
  /**
   * Give up waiting for sign-in to complete after this many milliseconds.
   * `0` (the default) waits forever, appropriate for the interactive command
   * where a human is at the window. Headless/automated recovery should pass
   * a real value so a profile that can't recover silently fails fast instead
   * of hanging the calling command indefinitely.
   */
  timeoutMs?: number;
}

/**
 * Best-effort: tick Apple's "Keep me signed in" checkbox whenever it appears
 * in the sign-in iframe, so the completed login is an extended session
 * (`extended_login: true`). Without it, the browser profile's own session
 * expires on the same short clock as our captured cookies - and then a
 * headless relaunch of the profile just lands on the logged-out landing
 * page with a password prompt, which is exactly what makes silent 421
 * recovery impossible (probed live, 2026-07-13 dev notes). Polling loop
 * rather than a one-shot wait because the checkbox only exists after the
 * user advances past the account-name step, and may be re-rendered.
 */
function keepMeSignedInWatcher(page: Page, isDone: () => boolean, status: (message: string) => void): Promise<void> {
  const POLL_INTERVAL_MS = 1_000;
  let announced = false;

  return (async () => {
    while (!isDone() && !page.isClosed()) {
      for (const frame of page.frames()) {
        if (!frame.url().includes("idmsa.apple.com")) {
          continue;
        }
        try {
          const checkbox = frame.getByLabel(/keep me signed in/i).first();
          if ((await checkbox.count()) > 0 && !(await checkbox.isChecked())) {
            await checkbox.check({ timeout: 2_000 });
            if (!announced) {
              announced = true;
              status('Ticked "Keep me signed in" so the session survives long idle periods.');
            }
          }
        } catch {
          // The frame navigated away mid-poll, or the checkbox isn't
          // interactable right now - never let this kill the login.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  })();
}

/**
 * Opens the login window and resolves with a captured session once sign-in
 * completes. Rejects if the user closes the window first (interactive mode)
 * or if `timeoutMs` elapses (headless mode). The window is always closed
 * afterwards - the browser never lingers, so its own 14-minute /validate
 * heartbeat can't race the captured token the way a live tab raced
 * HAR-imported sessions.
 */
export async function performBrowserLogin(options: BrowserLoginOptions = {}): Promise<IcloudSession> {
  const profileDir = options.profileDir ?? DEFAULT_BROWSER_PROFILE_DIR;
  const status = options.onStatus ?? ((message: string) => console.log(message));
  const headless = options.headless ?? false;
  const timeoutMs = options.timeoutMs ?? 0;
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless, viewport: null });
  } catch (cause) {
    throw new Error(
      'Could not launch the login browser. If Playwright\'s Chromium is not installed yet, run "npx playwright install chromium" and retry.',
      { cause },
    );
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    // Start listening before navigating: if the persistent profile is still
    // logged in, the success signal is the page-load /validate itself.
    const successPromise = context.waitForEvent("response", {
      predicate: (response) => SETUP_SUCCESS_PATTERN.test(response.url()) && response.ok(),
      timeout: timeoutMs,
    });

    await page.goto(ICLOUD_HOME);
    if (!headless) {
      status("Complete the sign-in in the browser window (password + any 2FA prompt).");
      status("Waiting for sign-in to finish... (close the window to abort)");
    }

    // Runs alongside the wait below; stops on its own once sign-in completes
    // (or the window closes). Interactive logins only - a headless recovery
    // relaunch either auto-validates from the profile's session or fails, no
    // sign-in form is ever completed there.
    let signInDone = false;
    const watcher = headless
      ? Promise.resolve()
      : keepMeSignedInWatcher(page, () => signInDone, status).catch(() => undefined);

    let response;
    try {
      response = await successPromise;
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      throw new Error(
        timedOut
          ? `Timed out after ${timeoutMs}ms waiting for sign-in to complete.`
          : "The browser window was closed before sign-in completed.",
        { cause },
      );
    }

    // The success response's own Set-Cookie headers mint the freshest tokens;
    // wait for the response to fully land, then give the browser a moment to
    // commit them to the jar before snapshotting it.
    await response.finished();
    signInDone = true;
    await watcher;
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const cookies = await context.cookies();
    return sessionFromBrowserCapture(cookies, response.url());
  } finally {
    await context.close().catch(() => undefined);
  }
}
