import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendDebugLog, loggedFetch, readDebugLogSince } from "./debugLog.js";

interface LoggedRecord {
  note: string;
  request?: { headers: Record<string, string> };
  response?: {
    headers: Record<string, string>;
    body: Record<string, unknown> & { nested?: Record<string, unknown> };
  };
}

async function withTempLogPath(run: (logPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "debuglog-test-"));
  try {
    await run(path.join(dir, "debug.log"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readLoggedRecords(logPath: string): Promise<LoggedRecord[]> {
  const raw = await readFile(logPath, "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LoggedRecord);
}

test("redacts known-sensitive header and body fields before writing", () =>
  withTempLogPath(async (logPath) => {
    await appendDebugLog(
      {
        note: "signInComplete",
        request: {
          method: "POST",
          url: "https://idmsa.apple.com/appleauth/auth/signin/complete",
          headers: { Cookie: "aasp=super-secret", Accept: "application/json" },
        },
        response: {
          status: 409,
          headers: { "x-apple-session-token": "top-secret-token", "content-type": "application/json" },
          body: {
            authType: "hsa2",
            trustedDeviceCount: 1,
            sessionToken: "also-secret",
            nested: { m1: "secret-proof", visible: "ok" },
          },
        },
      },
      logPath,
    );

    const [record] = await readLoggedRecords(logPath);
    assert.ok(record);
    assert.equal(record.note, "signInComplete");
    assert.equal(record.request?.headers.Cookie, "[REDACTED, 17 chars]");
    assert.equal(record.request?.headers.Accept, "application/json");
    assert.equal(record.response?.headers["x-apple-session-token"], "[REDACTED, 16 chars]");
    assert.equal(record.response?.headers["content-type"], "application/json");
    assert.equal(record.response?.body.authType, "hsa2");
    assert.equal(record.response?.body.trustedDeviceCount, 1);
    assert.equal(record.response?.body.sessionToken, "[REDACTED]");
    assert.equal(record.response?.body.nested?.m1, "[REDACTED]");
    assert.equal(record.response?.body.nested?.visible, "ok");
  }));

test("appends multiple entries as separate JSON lines", () =>
  withTempLogPath(async (logPath) => {
    await appendDebugLog({ note: "first" }, logPath);
    await appendDebugLog({ note: "second" }, logPath);

    const records = await readLoggedRecords(logPath);
    assert.deepEqual(
      records.map((record) => record.note),
      ["first", "second"],
    );
  }));

test("creates the parent directory if it doesn't exist yet", () =>
  withTempLogPath(async (logPath) => {
    const nestedPath = path.join(path.dirname(logPath), "nested", "debug.log");
    await appendDebugLog({ note: "created" }, nestedPath);

    const records = await readLoggedRecords(nestedPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.note, "created");
  }));

test("readDebugLogSince returns an empty array when the log file doesn't exist", () =>
  withTempLogPath(async (logPath) => {
    assert.deepEqual(await readDebugLogSince(new Date(0), logPath), []);
  }));

test("readDebugLogSince only returns records at or after the given time", () =>
  withTempLogPath(async (logPath) => {
    const lines = [
      { timestamp: "2026-07-14T10:00:00.000Z", note: "tooOld" },
      { timestamp: "2026-07-14T12:00:00.000Z", note: "atBoundary" },
      { timestamp: "2026-07-14T13:00:00.000Z", note: "afterBoundary" },
    ];
    await writeFile(logPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");

    const records = await readDebugLogSince(new Date("2026-07-14T12:00:00.000Z"), logPath);
    assert.deepEqual(
      records.map((record) => record.note),
      ["atBoundary", "afterBoundary"],
    );
  }));

test("readDebugLogSince excludes a line whose timestamp string isn't a parseable date", () =>
  withTempLogPath(async (logPath) => {
    const lines = [
      { timestamp: "not-a-real-date", note: "unparseableTimestamp" },
      { timestamp: "2026-07-14T12:00:00.000Z", note: "good" },
    ];
    await writeFile(logPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");

    const records = await readDebugLogSince(new Date(0), logPath);
    assert.deepEqual(
      records.map((record) => record.note),
      ["good"],
    );
  }));

test("readDebugLogSince skips malformed lines instead of throwing", () =>
  withTempLogPath(async (logPath) => {
    const goodLine = JSON.stringify({ timestamp: "2026-07-14T12:00:00.000Z", note: "good" });
    await writeFile(
      logPath,
      ["not json at all", JSON.stringify({ note: "missingTimestamp" }), "", goodLine].join("\n") + "\n",
      "utf-8",
    );

    const records = await readDebugLogSince(new Date(0), logPath);
    assert.deepEqual(
      records.map((record) => record.note),
      ["good"],
    );
  }));

// --- loggedFetch hands back a readable, byte-exact response ------------------
//
// Guards for a real failure: the wrapper used to log from `response.clone()`
// and hand the original back, and against live CloudKit traffic the caller's
// own read then threw "Body is unusable: Body has already been read" - every
// `changes/zone` fetch of any size, making `object list` unable to complete
// (2026-08-02). These tests pin the properties the fix guarantees - one read,
// bytes preserved, status and headers passed through - rather than the live
// failure itself, which does not reproduce against a local server.

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: string, logPath: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await withTempLogPath((logPath) => run(`http://127.0.0.1:${port}/`, logPath));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("loggedFetch returns a large JSON response the caller can still read", () =>
  withServer(
    (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ records: Array.from({ length: 4000 }, (_, i) => ({ i, pad: "x".repeat(16) })) }));
    },
    async (url, logPath) => {
      const response = await loggedFetch("bigJson", url, { method: "GET", headers: {} }, logPath);
      const parsed = (await response.json()) as { records: { i: number }[] };
      assert.equal(parsed.records.length, 4000);

      const logged = (await readDebugLogSince(new Date(0), logPath)) as unknown as LoggedRecord[];
      assert.equal(logged.length, 1);
      assert.equal(((logged[0]?.response?.body as { records?: unknown[] })?.records ?? []).length, 4000);
    },
  ));

test("loggedFetch preserves binary bytes exactly, and doesn't try to log them as JSON", () =>
  withServer(
    (_request, response) => {
      response.setHeader("content-type", "image/png");
      // Bytes that are not valid UTF-8: a decode/re-encode round trip mangles
      // them, which would silently corrupt every downloaded attachment.
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]));
    },
    async (url, logPath) => {
      const response = await loggedFetch("binary", url, { method: "GET", headers: {} }, logPath);
      assert.deepEqual(
        [...Buffer.from(await response.arrayBuffer())],
        [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28],
      );

      const logged = (await readDebugLogSince(new Date(0), logPath)) as unknown as LoggedRecord[];
      assert.equal(logged[0]?.response?.body, null);
    },
  ));

test("loggedFetch passes through status and headers, including a bodiless 304", () =>
  withServer(
    (_request, response) => {
      response.statusCode = 304;
      response.setHeader("x-marker", "kept");
      response.end();
    },
    async (url, logPath) => {
      const response = await loggedFetch("notModified", url, { method: "GET", headers: {} }, logPath);
      assert.equal(response.status, 304);
      assert.equal(response.headers.get("x-marker"), "kept");
    },
  ));
