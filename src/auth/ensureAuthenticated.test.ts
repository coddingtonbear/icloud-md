import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureAuthenticated } from "./ensureAuthenticated.js";
import { loadSession, writeSessionFile, type IcloudSession } from "../session.js";
import type { AuthCheckResult } from "../cloudkit/setupClient.js";

function makeSession(cookie: string): IcloudSession {
  return {
    cookie,
    clientId: "client-1",
    clientBuildNumber: "2624Build13",
    clientMasteringNumber: "2624Build13",
    capturedAt: "2026-07-13T12:00:00.000Z",
  };
}

function ok(session: IcloudSession): Extract<AuthCheckResult, { ok: true }> {
  return { ok: true, dsid: "1234", appleId: "me@example.com", fullName: undefined, ckdatabasewsUrl: "https://p43-ckdatabasews.icloud.com", session };
}

async function withTempSessionPath(run: (sessionPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ensure-auth-test-"));
  try {
    await run(path.join(dir, "session.local.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("returns immediately and persists a rotated cookie when already authenticated", () =>
  withTempSessionPath(async (sessionPath) => {
    const session = makeSession("A=1");
    const rotated = makeSession("A=2");
    let calls = 0;

    const result = await ensureAuthenticated(session, sessionPath, {
      checkAuth: async () => {
        calls += 1;
        return ok(rotated);
      },
      recover: async () => {
        throw new Error("should not be called");
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.session.cookie, "A=2");
    assert.equal((await loadSession(sessionPath)).cookie, "A=2");
  }));

test("does not touch disk when the session was already valid and unrotated", () =>
  withTempSessionPath(async (sessionPath) => {
    const session = makeSession("A=1");
    await writeSessionFile(session, sessionPath);

    await ensureAuthenticated(session, sessionPath, {
      checkAuth: async () => ok(session),
      recover: async () => {
        throw new Error("should not be called");
      },
    });

    assert.equal((await loadSession(sessionPath)).cookie, "A=1");
  }));

test("on a 421, recovers via a headless browser relaunch and persists the recovered session", () =>
  withTempSessionPath(async (sessionPath) => {
    const expired = makeSession("A=expired");
    const recoveredSession = makeSession("A=fresh");
    let recoverOptions: unknown;

    const result = await ensureAuthenticated(expired, sessionPath, {
      checkAuth: async (session) => (session.cookie === "A=expired" ? { ok: false, status: 421, error: "expired" } : ok(recoveredSession)),
      recover: async (options) => {
        recoverOptions = options;
        return recoveredSession;
      },
    });

    assert.equal(result.session.cookie, "A=fresh");
    assert.equal((await loadSession(sessionPath)).cookie, "A=fresh");
    assert.equal((recoverOptions as { headless?: boolean }).headless, true);
    assert.ok(typeof (recoverOptions as { timeoutMs?: number }).timeoutMs === "number");
  }));

test("throws immediately on a non-421 failure, without attempting browser recovery", async () => {
  const session = makeSession("A=1");
  let recoverCalled = false;

  await assert.rejects(
    ensureAuthenticated(session, "/dev/null/unused.json", {
      checkAuth: async () => ({ ok: false, status: 500, error: "server error" }),
      recover: async () => {
        recoverCalled = true;
        return session;
      },
    }),
    /Not authenticated \(HTTP 500\)/,
  );
  assert.equal(recoverCalled, false);
});

test("throws a clear error when headless recovery itself fails", async () => {
  const session = makeSession("A=expired");

  await assert.rejects(
    ensureAuthenticated(session, "/dev/null/unused.json", {
      checkAuth: async () => ({ ok: false, status: 421, error: "expired" }),
      recover: async () => {
        throw new Error("timed out");
      },
    }),
    /silent \(headless\) re-authentication failed/,
  );
});

test("throws when the recovered session itself fails verification", async () => {
  const expired = makeSession("A=expired");
  const recoveredSession = makeSession("A=still-bad");

  await assert.rejects(
    ensureAuthenticated(expired, "/dev/null/unused.json", {
      checkAuth: async () => ({ ok: false, status: 421, error: "expired" }),
      recover: async () => recoveredSession,
    }),
    /Recovered a session via headless re-authentication, but it failed verification/,
  );
});
