import { DEFAULT_DEBUG_LOG_PATH, appendDebugLog, loggedFetch } from "../debugLog.js";
import { CloudKitRequestFailedError } from "../errors.js";

/**
 * `loggedFetch` for the CloudKit database endpoints, with throttle-aware
 * retries.
 *
 * Apple throttles bursty traffic: a long `push` sends hundreds of
 * `records/modify` calls, and eventually one comes back non-OK with an
 * explicit "come back later" - HTTP 503 (and, observed on the same endpoint,
 * HTTP 409) carrying `serverErrorCode: "TRY_AGAIN_LATER"` plus a `retryAfter`
 * count of seconds, repeated in the `Retry-After` header (2026-09-29). Before
 * this, any non-OK response threw immediately, so a single throttled write
 * aborted an entire push partway through, and the only recovery was re-running
 * the command by hand until it happened to finish. CloudKit also uses
 * `THROTTLED` as a zone-level code inside an HTTP 200 `changes/zone` body,
 * which is a different shape handled at that layer, not here.
 *
 * Only throttling is retried. Every other failure - 401/403, a genuine
 * protocol error, the signed-URL expiry `fetchAssetBytes` documents - is
 * thrown on the first attempt exactly as before, because repeating those
 * either cannot help or would paper over a real problem.
 */
export interface CloudKitFailure {
  status: number;
  /** `serverErrorCode` from the response body, when it carried one. */
  serverErrorCode: string | null;
  /** The wait the server itself asked for, in ms, from `Retry-After` / `retryAfter`. */
  serverHintMs: number | null;
  /** True when this failure looks like throttling rather than an error. */
  throttled: boolean;
  /** How many attempts had been made when the failure was thrown. */
  attempts: number;
}

export interface ThrottleRetryOptions {
  /** Builds the message for the error thrown once attempts are exhausted. */
  describeFailure: (failure: CloudKitFailure) => string;
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /** Backoff before the second attempt, doubling for each one after that. */
  baseDelayMs?: number;
  /** Ceiling for any single wait, applied after the server's own hint. */
  maxDelayMs?: number;
  /** Seam for tests. */
  sleep?: (ms: number) => Promise<void>;
  debugLogPath?: string;
}

/**
 * HTTP statuses CloudKit uses to say "throttled" rather than "failed". 409 is
 * deliberately absent: on these endpoints a bare 409 can mean a changeTag
 * conflict rather than throttling, and every 409 actually observed carried
 * `TRY_AGAIN_LATER`, which the code check below catches anyway.
 */
const THROTTLE_STATUSES = new Set([429, 503]);

/** `serverErrorCode` values meaning "retry me", as opposed to a real error. */
const THROTTLE_SERVER_ERROR_CODES = new Set(["TRY_AGAIN_LATER", "THROTTLED"]);

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterMs(value: string | null): number | null {
  // CloudKit sends this as a whole number of seconds. The HTTP-date form is
  // also legal, but nothing has been observed sending it, so rather than
  // guess at a clock-dependent parse it just falls back to the backoff.
  if (value === null) {
    return null;
  }
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

/**
 * Reads what a failed response says about itself. Never throws: a body that
 * isn't JSON (an HTML error page, an empty 503) simply tells us nothing
 * beyond the status, which is how it was treated before.
 *
 * Reads a `clone()` rather than the response itself, so the caller can still
 * read the same body. Cloning is safe here for the same reason the swap in
 * `loggedFetch` was: this Response was rebuilt from bytes already in memory,
 * so there is no live network stream to hold two readers of.
 */
async function readFailure(
  response: Response,
): Promise<Omit<CloudKitFailure, "throttled" | "attempts">> {
  let serverErrorCode: string | null = null;
  let bodyHintMs: number | null = null;
  try {
    const body: unknown = await response.clone().json();
    if (isRecord(body)) {
      if (typeof body.serverErrorCode === "string") {
        serverErrorCode = body.serverErrorCode;
      }
      if (typeof body.retryAfter === "number" && Number.isFinite(body.retryAfter) && body.retryAfter >= 0) {
        bodyHintMs = body.retryAfter * 1_000;
      }
    }
  } catch {
    // Not JSON - nothing more to learn from the body.
  }

  const headerHintMs = retryAfterMs(response.headers.get("retry-after"));
  const hints = [bodyHintMs, headerHintMs].filter((hint): hint is number => hint !== null);

  return {
    status: response.status,
    serverErrorCode,
    serverHintMs: hints.length > 0 ? Math.max(...hints) : null,
  };
}

function isThrottled(failure: { status: number; serverErrorCode: string | null }): boolean {
  return (
    THROTTLE_STATUSES.has(failure.status) ||
    (failure.serverErrorCode !== null && THROTTLE_SERVER_ERROR_CODES.has(failure.serverErrorCode))
  );
}

/**
 * The server's own hint wins when it asks for longer than the backoff would,
 * and a ceiling keeps one throttled response from stalling a sync
 * indefinitely. Deliberately without jitter: this is one local client talking
 * to one account, so there is no herd to spread out, and a predictable wait
 * is the one that can be asserted in tests.
 */
function delayMs(failure: CloudKitFailure, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const backoffMs = baseDelayMs * 2 ** (attempt - 1);
  const wanted = Math.max(failure.serverHintMs ?? 0, backoffMs);
  return Math.min(wanted, maxDelayMs);
}

/**
 * The hint a caller sees when throttling outlasts the retries: the generic
 * "transient issue, try again" advice is technically right but unhelpful, so
 * say what happened and that the request did not go through.
 */
export function throttleExhaustedHint(failure: CloudKitFailure): string {
  const code = failure.serverErrorCode === null ? "" : ` (${failure.serverErrorCode})`;
  return (
    `iCloud throttled this request${code} and it did not go through - this tool tried it ` +
    `${failure.attempts} times. Waiting a minute and running the command again picks up where this left off.`
  );
}

/**
 * Issues one request through `loggedFetch`, retrying while the response looks
 * like throttling. Returns the response for the caller to read; throws the
 * `CloudKitRequestFailedError` built by `describeFailure` for a non-OK
 * response that isn't retryable, or that is still failing once attempts run
 * out.
 */
export async function fetchWithThrottleRetry(
  note: string,
  url: string,
  init: RequestInit & { headers: Record<string, string> },
  options: ThrottleRetryOptions,
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const debugLogPath = options.debugLogPath ?? DEFAULT_DEBUG_LOG_PATH;

  for (let attempt = 1; ; attempt += 1) {
    const response = await loggedFetch(note, url, init, debugLogPath);
    if (response.ok) {
      return response;
    }

    const failure: CloudKitFailure = {
      ...(await readFailure(response)),
      throttled: false,
      attempts: attempt,
    };
    failure.throttled = isThrottled(failure);

    if (!failure.throttled || attempt >= maxAttempts) {
      throw new CloudKitRequestFailedError(
        options.describeFailure(failure),
        failure.throttled ? { hint: throttleExhaustedHint(failure) } : {},
      );
    }

    const waitMs = delayMs(failure, attempt, baseDelayMs, maxDelayMs);
    // Worth a line in the debug log: without it a sync that stalled for
    // minutes looks identical to one that was simply slow.
    await appendDebugLog(
      {
        note:
          `${note}: iCloud throttled this request (HTTP ${failure.status}` +
          `${failure.serverErrorCode === null ? "" : `, ${failure.serverErrorCode}`}) - ` +
          `waiting ${waitMs}ms before attempt ${attempt + 1} of ${maxAttempts}`,
      },
      debugLogPath,
    );
    await sleep(waitMs);
  }
}
