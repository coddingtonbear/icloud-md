import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendDebugLog } from "./debugLog.js";

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
