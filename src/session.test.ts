import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadSession,
  mergeSetCookiesIntoSession,
  parseCookieHeader,
  parseSetCookieName,
  persistSessionIfRotated,
  writeSessionFile,
  type IcloudSession,
} from "./session.js";

async function withTempSessionPath(run: (sessionPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "session-test-"));
  try {
    await run(path.join(dir, "session.local.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeSession(cookie: string): IcloudSession {
  return {
    cookie,
    clientId: "client-1",
    clientBuildNumber: "2624Build13",
    clientMasteringNumber: "2624Build13",
    capturedAt: "2026-07-13T12:00:00.000Z",
  };
}

test("parseCookieHeader splits a cookie header into a name→value map", () => {
  const cookies = parseCookieHeader("A=1; B=2; C=3");
  assert.deepEqual([...cookies.entries()], [
    ["A", "1"],
    ["B", "2"],
    ["C", "3"],
  ]);
});

test("parseCookieHeader handles the empty string", () => {
  assert.deepEqual([...parseCookieHeader("").entries()], []);
});

test("parseSetCookieName extracts the name=value pair, dropping attributes", () => {
  assert.deepEqual(parseSetCookieName("X-APPLE-WEBAUTH-TOKEN=v=2:t=abc; Path=/; Domain=.icloud.com; Secure; HttpOnly"), {
    name: "X-APPLE-WEBAUTH-TOKEN",
    value: "v=2:t=abc",
  });
});

test("parseSetCookieName returns undefined for a malformed header", () => {
  assert.equal(parseSetCookieName("not-a-cookie"), undefined);
  assert.equal(parseSetCookieName(""), undefined);
});

test("mergeSetCookiesIntoSession rotates an existing cookie's value in place", () => {
  const session = makeSession("X-APPLE-WEBAUTH-TOKEN=old; X-APPLE-DS-WEB-SESSION-TOKEN=stable");
  const merged = mergeSetCookiesIntoSession(session, ["X-APPLE-WEBAUTH-TOKEN=new; Path=/; Secure"]);
  assert.equal(merged.cookie, "X-APPLE-WEBAUTH-TOKEN=new; X-APPLE-DS-WEB-SESSION-TOKEN=stable");
});

test("mergeSetCookiesIntoSession appends cookies the session didn't have yet", () => {
  const session = makeSession("A=1");
  const merged = mergeSetCookiesIntoSession(session, ["B=2; Path=/"]);
  assert.equal(merged.cookie, "A=1; B=2");
});

test("mergeSetCookiesIntoSession returns the same object when nothing actually changed", () => {
  const session = makeSession("A=1");
  assert.equal(mergeSetCookiesIntoSession(session, []), session);
  assert.equal(mergeSetCookiesIntoSession(session, ["A=1; Path=/"]), session);
});

test("mergeSetCookiesIntoSession leaves other session fields untouched", () => {
  const session = makeSession("A=1");
  const merged = mergeSetCookiesIntoSession(session, ["A=2"]);
  assert.equal(merged.clientId, session.clientId);
  assert.equal(merged.capturedAt, session.capturedAt);
});

test("persistSessionIfRotated writes to disk when the cookie jar changed", () =>
  withTempSessionPath(async (sessionPath) => {
    const previous = makeSession("A=1");
    const next = makeSession("A=2");

    await persistSessionIfRotated(previous, next, sessionPath);

    const written = await loadSession(sessionPath);
    assert.equal(written.cookie, "A=2");
  }));

test("persistSessionIfRotated is a no-op when the cookie jar is unchanged", () =>
  withTempSessionPath(async (sessionPath) => {
    const session = makeSession("A=1");
    await writeSessionFile(session, sessionPath);
    const beforeMtime = (await readFile(sessionPath, "utf8")).length;

    await persistSessionIfRotated(session, makeSession("A=1"), sessionPath);

    const afterMtime = (await readFile(sessionPath, "utf8")).length;
    assert.equal(afterMtime, beforeMtime);
  }));
