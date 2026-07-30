import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  accountDir,
  accountProfileDir,
  accountSessionPath,
  discardEphemeralProfile,
  findAccount,
  listAccounts,
  newEphemeralProfileDir,
  promoteEphemeralProfile,
  readAccountMeta,
  writeAccountMeta,
} from "./accountStore.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "accountstore-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("accountSessionPath/accountProfileDir nest under accountDir for the same dsid", () => {
  const root = "/tmp/accounts-root";
  assert.equal(accountDir("1234", root), "/tmp/accounts-root/1234");
  assert.equal(accountSessionPath("1234", root), "/tmp/accounts-root/1234/session.local.json");
  assert.equal(accountProfileDir("1234", root), "/tmp/accounts-root/1234/browser-profile");
});

test("readAccountMeta returns undefined when no account has ever been written for this dsid", () =>
  withTempRoot(async (root) => {
    assert.equal(await readAccountMeta("never-seen", root), undefined);
  }));

test("writeAccountMeta then readAccountMeta round-trips, and the file is only user-readable", () =>
  withTempRoot(async (root) => {
    await writeAccountMeta({ appleId: "me@example.com", dsid: "1234" }, root);

    const meta = await readAccountMeta("1234", root);
    assert.deepEqual(meta, { appleId: "me@example.com", dsid: "1234" });

    const info = await stat(path.join(root, "1234", "meta.json"));
    assert.equal(info.mode & 0o777, 0o600);
  }));

test("writeAccountMeta overwrites an existing account's meta in place", () =>
  withTempRoot(async (root) => {
    await writeAccountMeta({ appleId: "old@example.com", dsid: "1234" }, root);
    await writeAccountMeta({ appleId: "new@example.com", dsid: "1234" }, root);

    assert.deepEqual(await readAccountMeta("1234", root), { appleId: "new@example.com", dsid: "1234" });
  }));

test("newEphemeralProfileDir creates a fresh directory each call", () =>
  withTempRoot(async (root) => {
    const first = await newEphemeralProfileDir(root);
    const second = await newEphemeralProfileDir(root);

    assert.notEqual(first, second);
    assert.ok((await stat(first)).isDirectory());
    assert.ok((await stat(second)).isDirectory());
  }));

test("discardEphemeralProfile removes the directory without complaint if it's already gone", () =>
  withTempRoot(async (root) => {
    const dir = await newEphemeralProfileDir(root);
    await discardEphemeralProfile(dir);
    await assert.doesNotReject(discardEphemeralProfile(dir));

    await assert.rejects(stat(dir));
  }));

test("promoteEphemeralProfile moves the ephemeral directory into the account's browser-profile", () =>
  withTempRoot(async (root) => {
    const tmpRoot = path.join(root, "tmp");
    const accountsRoot = path.join(root, "accounts");
    const ephemeral = await newEphemeralProfileDir(tmpRoot);
    await writeFileMarker(ephemeral, "Default/Cookies", "fake-cookie-db");

    await promoteEphemeralProfile(ephemeral, "1234", accountsRoot);

    const promotedPath = accountProfileDir("1234", accountsRoot);
    assert.equal(
      await readFile(path.join(promotedPath, "Default/Cookies"), "utf8"),
      "fake-cookie-db",
    );
    await assert.rejects(stat(ephemeral));
  }));

test("promoteEphemeralProfile replaces a previously-promoted profile for the same dsid", () =>
  withTempRoot(async (root) => {
    const tmpRoot = path.join(root, "tmp");
    const accountsRoot = path.join(root, "accounts");

    const first = await newEphemeralProfileDir(tmpRoot);
    await writeFileMarker(first, "marker", "first");
    await promoteEphemeralProfile(first, "1234", accountsRoot);

    const second = await newEphemeralProfileDir(tmpRoot);
    await writeFileMarker(second, "marker", "second");
    await promoteEphemeralProfile(second, "1234", accountsRoot);

    assert.equal(await readFile(path.join(accountProfileDir("1234", accountsRoot), "marker"), "utf8"), "second");
  }));

test("listAccounts returns every account with a readable meta.json, and nothing else", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    assert.deepEqual(await listAccounts(accountsRoot), [], "a missing accounts root is simply empty");

    await writeAccountMeta({ appleId: "one@example.com", dsid: "111" }, accountsRoot);
    await writeAccountMeta({ appleId: "two@example.com", dsid: "222" }, accountsRoot);
    // A half-written account directory - no meta.json - must not be reported.
    await mkdir(path.join(accountsRoot, "333"), { recursive: true });

    const accounts = await listAccounts(accountsRoot);
    assert.deepEqual(
      accounts.map((account) => account.dsid).sort(),
      ["111", "222"],
    );
  }));

test("findAccount resolves an Apple ID or a dsid, and returns undefined for neither", () =>
  withTempRoot(async (root) => {
    const accountsRoot = path.join(root, "accounts");
    await writeAccountMeta({ appleId: "Person@Example.com", dsid: "111" }, accountsRoot);

    assert.equal((await findAccount("111", accountsRoot))?.appleId, "Person@Example.com");
    assert.equal((await findAccount("person@example.com", accountsRoot))?.dsid, "111");
    assert.equal((await findAccount("  PERSON@EXAMPLE.COM  ", accountsRoot))?.dsid, "111");
    assert.equal(await findAccount("nobody@example.com", accountsRoot), undefined);
  }));

async function writeFileMarker(dir: string, relativePath: string, contents: string): Promise<void> {
  const fullPath = path.join(dir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, "utf8");
}
