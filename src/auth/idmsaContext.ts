import { mergeSetCookies } from "./cookieJar.js";

/**
 * Round-tripped state threaded through one login's sequence of idmsa.apple.com
 * calls. Lives only for the duration of a single `login` invocation - not
 * persisted, not module-level state.
 *
 * `sessionId` (replayed as the `X-Apple-ID-Session-Id` request header) is
 * deliberately NOT captured generically here: the server never sends a header
 * of that name back. Its value comes from the `x-apple-session-token`
 * response header on specific calls (signin/complete), and only that call's
 * result should decide when to adopt a new one - other responses (e.g.
 * /2sv/trust) also carry an `x-apple-session-token` header but for a
 * different purpose (it becomes accountLogin's dsWebAuthToken, not the next
 * session-id header). See idmsaClient.ts/login.ts for where that value is
 * threaded through explicitly.
 */
export interface IdmsaContext {
  cookie: string;
  scnt: string | undefined;
  sessionId: string | undefined;
}

export const EMPTY_IDMSA_CONTEXT: IdmsaContext = { cookie: "", scnt: undefined, sessionId: undefined };

/** Folds a response's `scnt` header and any `Set-Cookie` headers into the context. */
export function updateIdmsaContext(context: IdmsaContext, headers: Headers): IdmsaContext {
  return {
    cookie: mergeSetCookies(context.cookie, headers.getSetCookie()),
    scnt: headers.get("scnt") ?? context.scnt,
    sessionId: context.sessionId,
  };
}
