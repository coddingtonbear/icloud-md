import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
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
 * sufficient. The direct SRP flow in login.ts remains as an opt-in fallback
 * for non-2FA/already-trusted accounts.
 */

/**
 * The login browser's own persistent state (cookies, local storage, and the
 * device trust Apple grants after a completed 2FA). Reusing one profile means
 * repeat logins look like a returning browser and typically skip 2FA entirely -
 * the browser profile plays the role the SRP flow's trustToken plays.
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
 * as fallback. No trustToken: for browser logins, the persistent profile
 * carries the trust instead.
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
}

/**
 * Opens the headed login window and resolves with a captured session once
 * sign-in completes. Rejects if the user closes the window first. The window
 * is always closed afterwards - the browser never lingers, so its own
 * 14-minute /validate heartbeat can't race the captured token the way a live
 * tab raced HAR-imported sessions.
 */
export async function performBrowserLogin(options: BrowserLoginOptions = {}): Promise<IcloudSession> {
  const profileDir = options.profileDir ?? DEFAULT_BROWSER_PROFILE_DIR;
  const status = options.onStatus ?? ((message: string) => console.log(message));
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: null });
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
      timeout: 0,
    });

    await page.goto(ICLOUD_HOME);
    status("Complete the sign-in in the browser window (password + any 2FA prompt).");
    status("Waiting for sign-in to finish... (close the window to abort)");

    let response;
    try {
      response = await successPromise;
    } catch (cause) {
      // waitForEvent only rejects here when the context/window went away.
      throw new Error("The browser window was closed before sign-in completed.", { cause });
    }

    // The success response's own Set-Cookie headers mint the freshest tokens;
    // wait for the response to fully land, then give the browser a moment to
    // commit them to the jar before snapshotting it.
    await response.finished();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const cookies = await context.cookies();
    return sessionFromBrowserCapture(cookies, response.url());
  } finally {
    await context.close().catch(() => undefined);
  }
}
