import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Same reason as `databaseClient.bodyLookup.test.ts`: `loggedFetch` writes to
// the debug log under the config dir resolved when `configDir.ts` loads, so
// HOME is pointed at a scratch dir before the dynamic imports.
const scratchHome = await mkdtemp(path.join(tmpdir(), "icloud-md-test-home-"));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

const { fetchWithThrottleRetry } = await import("./throttleRetry.js");
const { fetchAssetBytes, updateRecords } = await import("./databaseClient.js");
const { CloudKitRequestFailedError } = await import("../errors.js");

const session = {
  cookie: "cookie",
  clientId: "client-id",
  clientBuildNumber: "build",
  clientMasteringNumber: "mastering",
  capturedAt: new Date().toISOString(),
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The exact body the live endpoint returned when it throttled a `push`
 * (2026-09-29): status 503, `retryAfter` seconds in the body and repeated in
 * the `Retry-After` header. */
function throttledResponse(status = 503, retryAfterSeconds: number | null = 10): Response {
  const headers: Record<string, string> = retryAfterSeconds === null ? {} : { "retry-after": String(retryAfterSeconds) };
  return jsonResponse({ retryAfter: retryAfterSeconds, serverErrorCode: "TRY_AGAIN_LATER" }, status, headers);
}

/** Serves one canned response per call, holding the last one for any call after that. */
function installFetchMock(respond: (call: number, url: string) => Response): {
  restore: () => void;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const realFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init: structuredClone(init) });
    return respond(calls.length, href);
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = realFetch), calls };
}

function recordingSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

/** Runs `start` with `setTimeout` mocked, advancing the clock in one big step
 * each turn until the promise settles, so a retry test costs no real time. */
async function withMockedTimers<T>(t: TestContext, start: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const pending = start();
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    const deadline = performance.now() + 5_000;
    while (!settled) {
      assert.ok(performance.now() < deadline, "retry promise did not settle within 5 seconds of real time");
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(300_000);
    }
    return await pending;
  } finally {
    t.mock.timers.reset();
  }
}

test("mocked retry timers are reset even when the operation throws or rejects", async (t) => {
  let leakedTimerRan = false;
  await assert.rejects(
    withMockedTimers(t, () => {
      setTimeout(() => (leakedTimerRan = true), 1);
      throw new Error("start failed");
    }),
    /start failed/,
  );
  await assert.rejects(
    withMockedTimers(t, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  await withMockedTimers(t, () => new Promise((resolve) => setTimeout(resolve, 1)));
  assert.equal(leakedTimerRan, false);
});

test("a throttled request is waited out and retried instead of failing the sync", async () => {
  const mock = installFetchMock((call) => (call === 1 ? throttledResponse() : jsonResponse({ ok: true })));
  const { waits, sleep } = recordingSleep();
  try {
    const response = await fetchWithThrottleRetry(
      "updateRecords:records/modify",
      "https://ckdatabasews.example/database/1/com.apple.notes/production/private/records/modify",
      { method: "POST", headers: { Cookie: session.cookie } },
      { describeFailure: (failure) => `HTTP ${failure.status}`, sleep },
    );
    assert.equal(response.status, 200);
    assert.equal(mock.calls.length, 2);
    // The server asked for 10s, the backoff would have been 1s: the server's hint wins.
    assert.deepEqual(waits, [10_000]);
  } finally {
    mock.restore();
  }
});

test("the backoff takes over when the server asks for less than it would", async () => {
  const mock = installFetchMock((call) => (call < 3 ? throttledResponse(503, 1) : jsonResponse({ ok: true })));
  const { waits, sleep } = recordingSleep();
  try {
    await fetchWithThrottleRetry(
      "note",
      "https://ckdatabasews.example/x",
      { method: "POST", headers: {} },
      { describeFailure: (failure) => `HTTP ${failure.status}`, sleep },
    );
    assert.deepEqual(waits, [1_000, 2_000]);
  } finally {
    mock.restore();
  }
});

test("a 120-second server hint is not shortened to the backoff cap", async () => {
  const mock = installFetchMock((call) => (call === 1 ? throttledResponse(503, 120) : jsonResponse({ ok: true })));
  const { waits, sleep } = recordingSleep();
  try {
    await fetchWithThrottleRetry(
      "note",
      "https://ckdatabasews.example/x",
      { method: "POST", headers: {} },
      { describeFailure: (failure) => `HTTP ${failure.status}`, sleep },
    );
    assert.deepEqual(waits, [120_000]);
  } finally {
    mock.restore();
  }
});

test("a single server hint is capped at five minutes", async () => {
  const mock = installFetchMock((call) => (call === 1 ? throttledResponse(503, 600) : jsonResponse({ ok: true })));
  const { waits, sleep } = recordingSleep();
  try {
    await fetchWithThrottleRetry(
      "note",
      "https://ckdatabasews.example/x",
      { method: "POST", headers: {} },
      { describeFailure: (failure) => `HTTP ${failure.status}`, sleep },
    );
    assert.deepEqual(waits, [300_000]);
  } finally {
    mock.restore();
  }
});

test("exponential backoff stays capped at 30 seconds without a server hint", async () => {
  const mock = installFetchMock(() => throttledResponse(503, null));
  const { waits, sleep } = recordingSleep();
  try {
    await assert.rejects(
      fetchWithThrottleRetry(
        "note",
        "https://ckdatabasews.example/x",
        { method: "POST", headers: {} },
        { describeFailure: (failure) => `HTTP ${failure.status}`, maxAttempts: 8, sleep },
      ),
      /HTTP 503/,
    );
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  } finally {
    mock.restore();
  }
});

test("a bodyless response with a throttling status is retried on the status alone", async () => {
  // A 503 with no JSON body still means "come back later", and 409 is retried
  // only when it says TRY_AGAIN_LATER - a bare 409 on these endpoints can be a
  // changeTag conflict, and retrying that would just repeat it.
  const mock = installFetchMock((call) =>
    call === 1 ? new Response(null, { status: 503 }) : jsonResponse({ ok: true }),
  );
  const { waits, sleep } = recordingSleep();
  try {
    const response = await fetchWithThrottleRetry(
      "note",
      "https://ckdatabasews.example/x",
      { method: "POST", headers: {} },
      { describeFailure: (failure) => `HTTP ${failure.status}`, sleep },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(waits, [1_000]);
  } finally {
    mock.restore();
  }
});

test("a 409 carrying TRY_AGAIN_LATER is retried, a bare 409 is not", async () => {
  const throttled = installFetchMock((call) => (call === 1 ? throttledResponse(409) : jsonResponse({ ok: true })));
  const { sleep } = recordingSleep();
  try {
    const response = await fetchWithThrottleRetry(
      "note",
      "https://ckdatabasews.example/x",
      { method: "POST", headers: {} },
      { describeFailure: (failure) => `HTTP ${failure.status}`, sleep },
    );
    assert.equal(response.status, 200);
    assert.equal(throttled.calls.length, 2);
  } finally {
    throttled.restore();
  }

  const conflict = installFetchMock(() => jsonResponse({ serverErrorCode: "CONFLICT" }, 409));
  try {
    await assert.rejects(
      fetchWithThrottleRetry(
        "note",
        "https://ckdatabasews.example/x",
        { method: "POST", headers: {} },
        { describeFailure: (failure) => `HTTP ${failure.status}`, sleep },
      ),
      /HTTP 409/,
    );
    assert.equal(conflict.calls.length, 1);
  } finally {
    conflict.restore();
  }
});

test("a non-throttle failure is thrown on the first attempt, message and hint unchanged", async () => {
  const mock = installFetchMock(() => new Response("nope", { status: 403 }));
  const { waits, sleep } = recordingSleep();
  try {
    await assert.rejects(
      fetchWithThrottleRetry(
        "note",
        "https://ckdatabasews.example/x",
        { method: "POST", headers: {} },
        { describeFailure: (failure) => `request failed: HTTP ${failure.status}`, sleep },
      ),
      (error: unknown) =>
        error instanceof CloudKitRequestFailedError &&
        error.message === "request failed: HTTP 403" &&
        /transient network or iCloud-service issue/.test(error.hint ?? ""),
    );
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(waits, []);
  } finally {
    mock.restore();
  }
});

test("giving up reports throttling without promising resume or that writes were not applied", async () => {
  const mock = installFetchMock(() => throttledResponse());
  const { waits, sleep } = recordingSleep();
  try {
    await assert.rejects(
      fetchWithThrottleRetry(
        "note",
        "https://ckdatabasews.example/x",
        { method: "POST", headers: {} },
        { describeFailure: (failure) => `request failed: HTTP ${failure.status}`, maxAttempts: 4, sleep },
      ),
      (error: unknown) =>
        error instanceof CloudKitRequestFailedError &&
        error.message === "request failed: HTTP 503" &&
        /throttled this request \(TRY_AGAIN_LATER\).*tried it 4 times/s.test(error.hint ?? "") &&
        /Wait before trying again/.test(error.hint ?? "") &&
        !/did not go through|picks up where|resume/i.test(error.hint ?? ""),
    );
    assert.equal(mock.calls.length, 4);
    assert.deepEqual(waits, [10_000, 10_000, 10_000]);
  } finally {
    mock.restore();
  }
});

test("a push waits out a throttled records/modify call rather than aborting", async (t) => {
  const mock = installFetchMock((call) =>
    call === 1
      ? throttledResponse()
      : jsonResponse({
          records: [
            {
              recordName: "note-1",
              recordType: "Note",
              recordChangeTag: "tag-2",
              fields: { TitleEncrypted: { value: "dGl0bGU=", type: "ENCRYPTED_BYTES" } },
            },
          ],
        }),
  );
  try {
    const results = await withMockedTimers(t, () =>
      updateRecords(session, "https://ckdatabasews.example", "12345", "private", { zoneName: "Notes" }, [
        {
          recordName: "note-1",
          recordType: "Note",
          recordChangeTag: "tag-1",
          fields: { TitleEncrypted: { value: "dGl0bGU=" } },
        },
      ]),
    );
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0]?.init?.method, "POST");
    assert.equal(typeof mock.calls[0]?.init?.body, "string");
    assert.ok(mock.calls[0]?.init?.headers);
    // Snapshot the actual fetch arguments so replay cannot change the URL,
    // method, headers, or serialized request body (including its changeTag).
    assert.deepEqual(mock.calls[1], mock.calls[0]);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, true);
  } finally {
    mock.restore();
  }
});

test("an attachment download waits out a throttled response too", async (t) => {
  const mock = installFetchMock((call) =>
    call === 1 ? throttledResponse() : new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  );
  try {
    const bytes = await withMockedTimers(t, () =>
      fetchAssetBytes("https://cvws.icloud-content.com/asset?e=expiry&signature=x"),
    );
    assert.equal(mock.calls.length, 2);
    assert.deepEqual([...bytes], [1, 2, 3]);
  } finally {
    mock.restore();
  }
});

test("a throttled response is recorded in the debug log, so a slow sync is explainable", async () => {
  const { readDebugLogSince } = await import("../debugLog.js");
  const mock = installFetchMock((call) => (call === 1 ? throttledResponse() : jsonResponse({ ok: true })));
  const { sleep } = recordingSleep();
  const since = new Date();
  try {
    await fetchWithThrottleRetry(
      "updateRecords:records/modify",
      "https://ckdatabasews.example/x",
      { method: "POST", headers: {} },
      { describeFailure: (failure) => `HTTP ${failure.status}`, sleep },
    );
    const entries = await readDebugLogSince(since);
    assert.ok(
      entries.some((entry) => /throttled this request|iCloud throttled/.test(entry.note)),
      `expected a throttle entry, got: ${entries.map((entry) => entry.note).join(" | ")}`,
    );
  } finally {
    mock.restore();
  }
});
