import type { IcloudSession } from "../session.js";
import { loggedFetch } from "../debugLog.js";

const SETUP_HOST = "https://setup.icloud.com";

export type AuthCheckResult =
  | {
      ok: true;
      dsid: string;
      appleId: string;
      fullName: string | undefined;
      /** Base URL of the CloudKit database web service for this account's partition, e.g. https://p43-ckdatabasews.icloud.com:443 */
      ckdatabasewsUrl: string | undefined;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

/**
 * Hits the same endpoint the icloud.com web client uses on page load to confirm
 * an existing session is still valid. Doubles as account bootstrap: a successful
 * response carries the account's dsid and per-service partition hosts (e.g. which
 * `p<N>-ckdatabasews.icloud.com` to talk to for CloudKit calls).
 */
export async function checkAuthentication(session: IcloudSession, dsid?: string): Promise<AuthCheckResult> {
  const params = new URLSearchParams({
    clientBuildNumber: session.clientBuildNumber,
    clientMasteringNumber: session.clientMasteringNumber,
    clientId: session.clientId,
    requestId: crypto.randomUUID(),
  });
  if (dsid) {
    params.set("dsid", dsid);
  }

  const response = await loggedFetch("checkAuthentication", `${SETUP_HOST}/setup/ws/1/validate?${params.toString()}`, {
    method: "POST",
    headers: {
      Cookie: session.cookie,
      Origin: "https://www.icloud.com",
      Referer: "https://www.icloud.com/",
      Accept: "application/json",
    },
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    return { ok: false, status: response.status, error };
  }

  if (!isRecord(body) || !isRecord(body.dsInfo)) {
    return { ok: false, status: response.status, error: "Unexpected response shape from /validate (missing dsInfo)" };
  }

  const dsInfo = body.dsInfo;
  const appleId = typeof dsInfo.appleId === "string" ? dsInfo.appleId : undefined;
  const resolvedDsid = typeof dsInfo.dsid === "string" ? dsInfo.dsid : undefined;
  const fullName = typeof dsInfo.fullName === "string" ? dsInfo.fullName : undefined;

  if (!appleId || !resolvedDsid) {
    return { ok: false, status: response.status, error: "Missing appleId/dsid in /validate response" };
  }

  const webservices = isRecord(body.webservices) ? body.webservices : undefined;
  const notesService = webservices && isRecord(webservices.ckdatabasews) ? webservices.ckdatabasews : undefined;
  const ckdatabasewsUrl = notesService && typeof notesService.url === "string" ? notesService.url : undefined;

  return { ok: true, dsid: resolvedDsid, appleId, fullName, ckdatabasewsUrl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
