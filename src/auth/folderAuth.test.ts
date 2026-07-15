import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountProfileDir, accountSessionPath, readAccountMeta, writeAccountMeta } from "./accountStore.js";
import { bindNewFolderAccount, reauthenticateFolder, resolveFolderAccount } from "./folderAuth.js";
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
