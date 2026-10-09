import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadSession,
  mergeSetCookiesIntoSession,
  parseCookieHeader,
  parseSetCookieName,
  persistSessionIfRotated,
  renameReplacing,
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

test("writeSessionFile leaves only the session file behind, owner-only", () =>
  withTempSessionPath(async (sessionPath) => {
    // Windows has no POSIX mode bits (stat reports 0o666 there), so only the
    // permission half of this test is POSIX-only.
    const posix = process.platform !== "win32";
    await writeSessionFile(makeSession("A=1"), sessionPath);
    if (posix) {
      await chmod(sessionPath, 0o644);
    }

    await writeSessionFile(makeSession("A=2"), sessionPath);

    assert.deepEqual(await readdir(path.dirname(sessionPath)), [path.basename(sessionPath)]);
    if (posix) {
      assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
    }
    assert.equal((await loadSession(sessionPath)).cookie, "A=2");
  }));

test("a session read during a rewrite sees the old or the new session, never a partial one", () =>
  withTempSessionPath(async (sessionPath) => {
    const big = (n: number) => makeSession(`A=${String(n).repeat(200_000)}`);
    await writeSessionFile(big(1), sessionPath);

    const writes = [2, 3, 4, 5].map((n) => writeSessionFile(big(n), sessionPath));
    const reads = Array.from({ length: 40 }, () => loadSession(sessionPath));
    await Promise.all(writes);

    for (const session of await Promise.all(reads)) {
      assert.match(session.cookie, /^A=(1+|2+|3+|4+|5+)$/);
    }
  }));

test("writeSessionFile rejects and leaves no temp file behind when the rename fails", () =>
  withTempSessionPath(async (sessionPath) => {
    // A directory where the session file should be makes the rename fail.
    await mkdir(sessionPath);

    await assert.rejects(writeSessionFile(makeSession("A=1"), sessionPath));

    assert.deepEqual(await readdir(path.dirname(sessionPath)), [path.basename(sessionPath)]);
  }));

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename failed`), { code });
}

/** A rename that fails with `codes`, in order, then succeeds. */
function flakyRename(codes: string[]): { renameFile: (from: string, to: string) => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    renameFile: async () => {
      const code = codes[calls];
      calls += 1;
      if (code !== undefined) {
        throw errnoError(code);
      }
    },
    calls: () => calls,
  };
}

const noSleep = async (): Promise<void> => {};

test("renameReplacing retries a rename Windows refuses while the target is held open", async () => {
  const flaky = flakyRename(["EPERM", "EBUSY", "EACCES"]);

  await renameReplacing("a.tmp", "a", { platform: "win32", renameFile: flaky.renameFile, sleep: noSleep });

  assert.equal(flaky.calls(), 4);
});

test("renameReplacing gives up on Windows after a bounded number of attempts", async () => {
  const flaky = flakyRename(Array.from({ length: 50 }, () => "EPERM"));

  await assert.rejects(
    renameReplacing("a.tmp", "a", { platform: "win32", renameFile: flaky.renameFile, sleep: noSleep }),
    /EPERM/,
  );
  assert.equal(flaky.calls(), 10);
});

test("renameReplacing doesn't retry other errors, or any error off Windows", async () => {
  const otherError = flakyRename(["EISDIR"]);
  await assert.rejects(
    renameReplacing("a.tmp", "a", { platform: "win32", renameFile: otherError.renameFile, sleep: noSleep }),
    /EISDIR/,
  );
  assert.equal(otherError.calls(), 1);

  const posix = flakyRename(["EPERM"]);
  await assert.rejects(renameReplacing("a.tmp", "a", { platform: "linux", renameFile: posix.renameFile, sleep: noSleep }), /EPERM/);
  assert.equal(posix.calls(), 1);
});
