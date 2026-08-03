import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountProfileDir, accountSessionPath, readAccountMeta, writeAccountMeta } from "./accountStore.js";
import { bindKnownAccount, bindNewFolderAccount, reauthenticateFolder, resolveFolderAccount } from "./folderAuth.js";
import {
  InteractiveSignInRefusedError,
  RequestedAccountMismatchError,
  SignInIncompleteError,
  UnknownAccountError,
} from "../errors.js";
import type { AuthCheckResult } from "../cloudkit/setupClient.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { writeSessionFile, type IcloudSession } from "../session.js";

function makeSession(cookie: string): IcloudSession {
  return {
    cookie,
    clientId: "client-1",
    clientBuildNumber: "2624Build13",
    clientMasteringNumber: "2624Build13",
    capturedAt: "2026-07-14T12:00:00.000Z",
  };
}

function ok(dsid: string, appleId: string, session: IcloudSession): Extract<AuthCheckResult, { ok: true }> {
  return { ok: true, dsid, appleId, fullName: undefined, ckdatabasewsUrl: "https://p43-ckdatabasews.icloud.com", session };
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "folderauth-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("bindNewFolderAccount creates a new account and promotes the ephemeral profile when the dsid is unseen", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const tmpRoot = path.join(root, "tmp");
    const session = makeSession("A=1");

    const auth = await bindNewFolderAccount({
      accountsRoot,
      tmpRoot,
      performBrowserLogin: async (options) => {
        assert.ok(options?.profileDir);
        await writeFile(path.join(options.profileDir, "marker"), "profile-data", "utf8");
        return session;
      },
      checkAuthentication: async () => ok("D1", "me@example.com", session),
    });

    assert.equal(auth.dsid, "D1");
    assert.equal(auth.appleId, "me@example.com");
    assert.deepEqual(await readAccountMeta("D1", accountsRoot), { appleId: "me@example.com", dsid: "D1" });
    assert.equal((await readSessionCookie(accountSessionPath("D1", accountsRoot))), "A=1");
    assert.equal(
      await readFile(path.join(accountProfileDir("D1", accountsRoot), "marker"), "utf8"),
      "profile-data",
    );
  }));

test("bindNewFolderAccount refreshes an existing account's session but leaves its persisted profile untouched", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const tmpRoot = path.join(root, "tmp");

    // Pre-seed an existing account, as an earlier login would have left it -
    // session, meta.json (the "have we seen this dsid before" signal), and a
    // marker file standing in for real device-trust profile data.
    await writeSessionFile(makeSession("A=old"), accountSessionPath("D1", accountsRoot));
    await writeAccountMeta({ appleId: "me@example.com", dsid: "D1" }, accountsRoot);
    await mkdir(accountProfileDir("D1", accountsRoot), { recursive: true });
    await writeFile(path.join(accountProfileDir("D1", accountsRoot), "existing-marker"), "already-trusted", "utf8");

    const refreshed = makeSession("A=fresh");
    const auth = await bindNewFolderAccount({
      accountsRoot,
      tmpRoot,
      performBrowserLogin: async (options) => {
        // The mock never writes into the ephemeral profileDir - simulates a
        // returning account whose device trust is already established.
        void options;
        return refreshed;
      },
      checkAuthentication: async () => ok("D1", "me@example.com", refreshed),
    });

    assert.equal(auth.dsid, "D1");
    assert.equal(await readSessionCookie(accountSessionPath("D1", accountsRoot)), "A=fresh");
    // The existing profile must survive untouched - never overwritten by a refresh.
    assert.equal(
      await readFile(path.join(accountProfileDir("D1", accountsRoot), "existing-marker"), "utf8"),
      "already-trusted",
    );
  }));

test("bindNewFolderAccount throws and cleans up the ephemeral profile when the captured session fails verification", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const tmpRoot = path.join(root, "tmp");
    let capturedProfileDir = "";

    await assert.rejects(
      bindNewFolderAccount({
        accountsRoot,
        tmpRoot,
        performBrowserLogin: async (options) => {
          assert.ok(options?.profileDir);
          capturedProfileDir = options.profileDir;
          return makeSession("A=1");
        },
        checkAuthentication: async () => ({ ok: false, status: 421, error: "session expired" }),
      }),
      /failed verification/,
    );

    assert.ok(capturedProfileDir);
    await assert.rejects(stat(capturedProfileDir));
  }));

test("bindNewFolderAccount reports the sign-in failure even when discarding the ephemeral profile also fails", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const tmpRoot = path.join(root, "tmp");

    try {
      await assert.rejects(
        bindNewFolderAccount({
          accountsRoot,
          tmpRoot,
          performBrowserLogin: async () => {
            // Make the ephemeral dir un-removable before failing, so the
            // finally-block cleanup throws too - the *sign-in* error must
            // still be the one that surfaces (a cleanup ENOTEMPTY/EACCES
            // masked a real SignInIncompleteError on 2026-07-18).
            await chmod(tmpRoot, 0o500);
            throw new Error("the real sign-in failure");
          },
          checkAuthentication: async () => {
            throw new Error("unreachable - login already failed");
          },
        }),
        /the real sign-in failure/,
      );
    } finally {
      await chmod(tmpRoot, 0o700);
    }
  }));

test("resolveFolderAccount throws UnboundAccountError when the folder has no bound account", async () => {
  await assert.rejects(resolveFolderAccount("/some/dir", undefined), /has no account bound to it/);
});

test("resolveFolderAccount throws AccountMismatchError when the resolved session is for a different account", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const expected = { appleId: "me@example.com", dsid: "D1" };
    await writeSessionFile(makeSession("A=1"), accountSessionPath("D1", accountsRoot));

    await assert.rejects(
      resolveFolderAccount("/some/dir", expected, {
        accountsRoot,
        ensureAuthenticated: async () => ok("D2", "someone-else@example.com", makeSession("A=1")),
      }),
      /was cloned for me@example\.com, but the session just authenticated is for someone-else@example\.com/,
    );
  }));

test("resolveFolderAccount returns the auth result when identities match", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const expected = { appleId: "me@example.com", dsid: "D1" };
    await writeSessionFile(makeSession("A=1"), accountSessionPath("D1", accountsRoot));

    const auth = await resolveFolderAccount("/some/dir", expected, {
      accountsRoot,
      ensureAuthenticated: async () => ok("D1", "me@example.com", makeSession("A=1")),
    });

    assert.equal(auth.dsid, "D1");
  }));

test("reauthenticateFolder throws NotClonedDirectoryError when the directory was never cloned", () =>
  withTempRoot(async (root) => {
    await assert.rejects(reauthenticateFolder(root), /doesn't look like a cloned notes directory/);
  }));

test("reauthenticateFolder throws UnboundAccountError when state.json predates account binding", () =>
  withTempRoot(async (root) => {
    const legacyState: CloneState = { syncToken: "token", notes: {} };
    await writeCloneState(root, legacyState);

    await assert.rejects(reauthenticateFolder(root), /has no account bound to it/);
  }));

test("reauthenticateFolder throws AccountMismatchError when the fresh login is for a different Apple ID", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts-root");
    const state: CloneState = {
      account: { appleId: "me@example.com", dsid: "D1" },
      syncToken: "token",
      notes: {},
    };
    await writeCloneState(root, state);

    await assert.rejects(
      reauthenticateFolder(root, {
        accountsRoot,
        performBrowserLogin: async () => makeSession("A=other"),
        checkAuthentication: async () => ok("D2", "someone-else@example.com", makeSession("A=other")),
      }),
      /was cloned for me@example\.com, but the session just authenticated is for someone-else@example\.com/,
    );
  }));

test("reauthenticateFolder on success updates the account's session and meta, and returns the identity", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts-root");
    const state: CloneState = {
      account: { appleId: "me@example.com", dsid: "D1" },
      syncToken: "token",
      notes: {},
    };
    await writeCloneState(root, state);

    const fresh = makeSession("A=fresh");
    const auth = await reauthenticateFolder(root, {
      accountsRoot,
      performBrowserLogin: async () => fresh,
      checkAuthentication: async () => ok("D1", "me@example.com", fresh),
    });

    assert.equal(auth.dsid, "D1");
    assert.equal(await readSessionCookie(accountSessionPath("D1", accountsRoot)), "A=fresh");
    assert.deepEqual(await readAccountMeta("D1", accountsRoot), { appleId: "me@example.com", dsid: "D1" });
  }));

async function readSessionCookie(sessionPath: string): Promise<string> {
  const raw = JSON.parse(await readFile(sessionPath, "utf8")) as { cookie: string };
  return raw.cookie;
}

test("bindKnownAccount reuses the named account's own trusted profile, headlessly", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const session = makeSession("KNOWN=1");
    await writeAccountMeta({ appleId: "someone@example.com", dsid: "555" }, accountsRoot);

    const profileDirsUsed: (string | undefined)[] = [];
    const auth = await bindKnownAccount("someone@example.com", {
      accountsRoot,
      performBrowserLogin: async (options) => {
        profileDirsUsed.push(options?.profileDir);
        // The whole point: no window, and a bounded wait.
        assert.equal(options?.headless, true);
        assert.ok((options?.timeoutMs ?? 0) > 0);
        return session;
      },
      checkAuthentication: async () => ok("555", "someone@example.com", session),
    });

    assert.equal(auth.dsid, "555");
    assert.deepEqual(profileDirsUsed, [accountProfileDir("555", accountsRoot)]);
    assert.deepEqual(JSON.parse(await readFile(accountSessionPath("555", accountsRoot), "utf8")), session);
  }));

test("bindKnownAccount matches on dsid as well as Apple ID, case-insensitively", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const session = makeSession("KNOWN=2");
    await writeAccountMeta({ appleId: "Mixed.Case@Example.com", dsid: "777" }, accountsRoot);

    for (const reference of ["777", "mixed.case@example.com", "MIXED.CASE@EXAMPLE.COM"]) {
      const auth = await bindKnownAccount(reference, {
        accountsRoot,
        performBrowserLogin: async () => session,
        checkAuthentication: async () => ok("777", "Mixed.Case@Example.com", session),
      });
      assert.equal(auth.dsid, "777", `reference ${reference} should resolve`);
    }
  }));

test("bindKnownAccount falls back to a visible window when the silent attempt fails", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const session = makeSession("RECOVERED=1");
    await writeAccountMeta({ appleId: "someone@example.com", dsid: "555" }, accountsRoot);

    const attempts: (boolean | undefined)[] = [];
    const auth = await bindKnownAccount("someone@example.com", {
      accountsRoot,
      performBrowserLogin: async (options) => {
        attempts.push(options?.headless);
        if (options?.headless === true) {
          throw new SignInIncompleteError("no silent recovery available");
        }
        return session;
      },
      checkAuthentication: async () => ok("555", "someone@example.com", session),
    });

    assert.equal(auth.dsid, "555");
    assert.deepEqual(attempts, [true, undefined], "silent attempt first, then a headed one");
  }));

test("bindKnownAccount rejects an unknown account, listing the ones that exist", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    await writeAccountMeta({ appleId: "real@example.com", dsid: "555" }, accountsRoot);

    await assert.rejects(
      () =>
        bindKnownAccount("typo@example.com", {
          accountsRoot,
          performBrowserLogin: async () => {
            throw new Error("should never attempt a login for an unknown account");
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof UnknownAccountError);
        assert.match(error.message, /typo@example\.com/);
        assert.match(error.hint ?? "", /real@example\.com/);
        return true;
      },
    );
  }));

/**
 * The regression the 2026-08-02 live run needs: a clone of an account that
 * already has a live session must not touch a browser at all. Relaunching the
 * account's profile is the step that failed there (see `reuseStoredSession`),
 * and holding a live session makes it unnecessary in the common case.
 */
test("bindKnownAccount reuses the account's stored session without launching a browser", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const stored = makeSession("STORED=1");
    await writeAccountMeta({ appleId: "someone@example.com", dsid: "555" }, accountsRoot);
    await writeSessionFile(stored, accountSessionPath("555", accountsRoot));

    const status: string[] = [];
    const auth = await bindKnownAccount("someone@example.com", {
      accountsRoot,
      onStatus: (message) => status.push(message),
      performBrowserLogin: async () => {
        throw new Error("a live stored session must not need a browser");
      },
      checkAuthentication: async (session) => {
        assert.equal(session.cookie, "STORED=1", "the stored session is what gets checked");
        return ok("555", "someone@example.com", session);
      },
    });

    assert.equal(auth.dsid, "555");
    assert.equal(auth.session.cookie, "STORED=1");
    assert.ok(
      status.some((message) => /Reusing someone@example\.com's saved session/.test(message)),
      `the reuse should be announced, got ${JSON.stringify(status)}`,
    );
  }));

test("bindKnownAccount persists a session the reuse check rotated", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    await writeAccountMeta({ appleId: "someone@example.com", dsid: "555" }, accountsRoot);
    await writeSessionFile(makeSession("STORED=1"), accountSessionPath("555", accountsRoot));

    // `/validate` rotates X-APPLE-WEBAUTH-TOKEN on every call; a rotation
    // that isn't written back leaves the next command re-presenting a token
    // this one already superseded.
    const rotated = makeSession("STORED=2");
    await bindKnownAccount("someone@example.com", {
      accountsRoot,
      performBrowserLogin: async () => {
        throw new Error("a live stored session must not need a browser");
      },
      checkAuthentication: async () => ok("555", "someone@example.com", rotated),
    });

    assert.equal(await readSessionCookie(accountSessionPath("555", accountsRoot)), "STORED=2");
  }));

test("bindKnownAccount falls back to the browser when the stored session no longer authenticates", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    await writeAccountMeta({ appleId: "someone@example.com", dsid: "555" }, accountsRoot);
    await writeSessionFile(makeSession("EXPIRED=1"), accountSessionPath("555", accountsRoot));

    const captured = makeSession("FRESH=1");
    const attempts: (boolean | undefined)[] = [];
    const auth = await bindKnownAccount("someone@example.com", {
      accountsRoot,
      performBrowserLogin: async (options) => {
        attempts.push(options?.headless);
        return captured;
      },
      checkAuthentication: async (session) =>
        session.cookie === "EXPIRED=1"
          ? { ok: false, status: 421, error: "session expired" }
          : ok("555", "someone@example.com", session),
    });

    assert.equal(auth.dsid, "555");
    assert.deepEqual(attempts, [true], "a stale stored session should still get the silent profile relaunch");
    assert.equal(await readSessionCookie(accountSessionPath("555", accountsRoot)), "FRESH=1");
  }));

test("bindKnownAccount refuses a stored session that authenticates as a different account", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    await writeAccountMeta({ appleId: "wanted@example.com", dsid: "555" }, accountsRoot);
    await writeSessionFile(makeSession("MISFILED=1"), accountSessionPath("555", accountsRoot));

    // An inconsistent store, not a stale one: guessing past it risks binding
    // the new folder to someone else's notes.
    await assert.rejects(
      () =>
        bindKnownAccount("wanted@example.com", {
          accountsRoot,
          performBrowserLogin: async () => {
            throw new Error("should never fall back to a browser after an identity mismatch");
          },
          checkAuthentication: async (session) => ok("999", "someoneelse@example.com", session),
        }),
      (error: unknown) => {
        assert.ok(error instanceof RequestedAccountMismatchError);
        assert.match(error.message, /someoneelse@example\.com/);
        return true;
      },
    );
  }));

test("bindKnownAccount refuses to open a window when non-interactive, instead of blocking on one", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    await writeAccountMeta({ appleId: "someone@example.com", dsid: "555" }, accountsRoot);
    await writeSessionFile(makeSession("EXPIRED=1"), accountSessionPath("555", accountsRoot));

    const attempts: (boolean | undefined)[] = [];
    await assert.rejects(
      () =>
        bindKnownAccount("someone@example.com", {
          accountsRoot,
          interactive: false,
          performBrowserLogin: async (options) => {
            attempts.push(options?.headless);
            throw new SignInIncompleteError("no silent recovery available");
          },
          checkAuthentication: async () => ({ ok: false, status: 421, error: "session expired" }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractiveSignInRefusedError);
        assert.match(error.message, /someone@example\.com/);
        assert.ok(error.cause instanceof SignInIncompleteError, "the silent attempt's failure is kept as the cause");
        return true;
      },
    );

    assert.deepEqual(attempts, [true], "the silent attempt still runs; only the visible one is refused");
  }));

test("bindNewFolderAccount refuses outright when non-interactive - it has nothing silent to try", () =>
  withTempRoot(async (root) => {
    await assert.rejects(
      () =>
        bindNewFolderAccount({
          accountsRoot: path.join(root, "accounts"),
          tmpRoot: path.join(root, "tmp"),
          interactive: false,
          performBrowserLogin: async () => {
            throw new Error("should never launch a browser when non-interactive");
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractiveSignInRefusedError);
        assert.match(error.hint ?? "", /--non-interactive/);
        return true;
      },
    );
  }));

test("bindKnownAccount refuses a sign-in that completed as a different Apple ID", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    const session = makeSession("WRONG=1");
    await writeAccountMeta({ appleId: "wanted@example.com", dsid: "555" }, accountsRoot);

    await assert.rejects(
      () =>
        bindKnownAccount("wanted@example.com", {
          accountsRoot,
          performBrowserLogin: async () => session,
          checkAuthentication: async () => ok("999", "someoneelse@example.com", session),
        }),
      (error: unknown) => {
        assert.ok(error instanceof RequestedAccountMismatchError);
        assert.match(error.message, /someoneelse@example\.com/);
        return true;
      },
    );

    // The wrong identity must not have been written anywhere.
    assert.equal(await readAccountMeta("999", accountsRoot), undefined);
  }));
