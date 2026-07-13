import { mergeSetCookies } from "./cookieJar.js";
import { loggedFetch } from "../debugLog.js";

/**
 * Mints icloud.com-scoped session cookies from the dsWebAuthToken obtained
 * either from signInComplete (already-trusted path) or from /2sv/trust
 * (post-2FA path). This is the point where IcloudSession.cookie is produced -
 * the real-login equivalent of what import-har previously lifted out of a
 * browser's HAR export.
 */
export async function mintIcloudSessionCookie(dsWebAuthToken: string): Promise<string> {
  const response = await loggedFetch("mintIcloudSessionCookie", "https://setup.icloud.com/setup/ws/1/accountLogin", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://www.icloud.com",
      Referer: "https://www.icloud.com/",
    },
    body: JSON.stringify({ dsWebAuthToken }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Not authenticated (HTTP ${response.status}): ${body}`);
  }

  return mergeSetCookies("", response.headers.getSetCookie());
}
