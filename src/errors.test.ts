import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthenticationExpiredError,
  ChromiumNotInstalledError,
  CloudKitRequestFailedError,
  CorruptSessionFileError,
  CorruptStateFileError,
  IcloudNotesSyncError,
  MissingSessionFileError,
  NotClonedDirectoryError,
  NotesUnavailableError,
  SignInIncompleteError,
  SilentReauthFailedError,
  UntrackedFileError,
} from "./errors.js";

test("IcloudNotesSyncError carries a message and an optional hint", () => {
  const withHint = new IcloudNotesSyncError("something went wrong", { hint: "try again" });
  assert.equal(withHint.message, "something went wrong");
  assert.equal(withHint.hint, "try again");
  assert.equal(withHint.name, "IcloudNotesSyncError");

  const withoutHint = new IcloudNotesSyncError("something went wrong");
  assert.equal(withoutHint.hint, undefined);
  assert.ok(!("hint" in withoutHint) || withoutHint.hint === undefined);
});

test("IcloudNotesSyncError preserves a `cause` passed via options", () => {
  const cause = new Error("root cause");
  const error = new IcloudNotesSyncError("wrapper", { cause });
  assert.equal(error.cause, cause);
});

test("subclasses report their own constructor name via `name`, and are all instances of IcloudNotesSyncError", () => {
  const errors: IcloudNotesSyncError[] = [
    new AuthenticationExpiredError(421, "HTTP 421"),
    new SilentReauthFailedError("headless recovery failed"),
    new NotClonedDirectoryError("/some/dir"),
    new MissingSessionFileError("/some/session.json"),
    new CorruptSessionFileError("session file is missing a field"),
    new ChromiumNotInstalledError(),
    new SignInIncompleteError("the browser window was closed before sign-in completed"),
    new NotesUnavailableError(),
    new CorruptStateFileError("state.json has a malformed replicaId"),
    new CloudKitRequestFailedError("records/lookup request failed (private db): HTTP 500"),
    new UntrackedFileError("missing-note.md", "/some/dir"),
  ];

  for (const error of errors) {
    assert.ok(error instanceof IcloudNotesSyncError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, error.constructor.name);
    assert.ok(error.hint, `${error.name} should have a hint`);
  }
});

test("AuthenticationExpiredError formats the HTTP status and detail into its message", () => {
  const error = new AuthenticationExpiredError(421, "HTTP 421");
  assert.equal(error.message, "Not authenticated (HTTP 421): HTTP 421");
  assert.match(error.hint ?? "", /login/);
});

test("NotClonedDirectoryError names the offending directory and points at `clone`", () => {
  const error = new NotClonedDirectoryError("/tmp/not-a-vault");
  assert.match(error.message, /\/tmp\/not-a-vault/);
  assert.match(error.hint ?? "", /clone/);
});

test("MissingSessionFileError names the session path and points at `login`", () => {
  const error = new MissingSessionFileError("/home/user/.config/icloud-notes-sync/session.local.json");
  assert.match(error.message, /session\.local\.json/);
  assert.match(error.hint ?? "", /login/);
});

test("MissingSessionFileError preserves the underlying fs error as `cause`", () => {
  const cause = new Error("ENOENT");
  const error = new MissingSessionFileError("/some/path", { cause });
  assert.equal(error.cause, cause);
});

test("ChromiumNotInstalledError points at the playwright install command", () => {
  const error = new ChromiumNotInstalledError();
  assert.match(error.hint ?? "", /playwright install chromium/);
});

test("NotesUnavailableError has a fixed message about the account not reporting a ckdatabasews host", () => {
  const error = new NotesUnavailableError();
  assert.match(error.message, /ckdatabasews/);
});

test("CorruptStateFileError points at re-cloning as the fix", () => {
  const error = new CorruptStateFileError("state.json has a malformed replicaId");
  assert.equal(error.message, "state.json has a malformed replicaId");
  assert.match(error.hint ?? "", /clone/);
});

test("CloudKitRequestFailedError keeps the operation/status detail in its message and gives a generic retry hint", () => {
  const error = new CloudKitRequestFailedError("records/lookup request failed (private db): HTTP 500");
  assert.equal(error.message, "records/lookup request failed (private db): HTTP 500");
  assert.match(error.hint ?? "", /try again/);
});

test("UntrackedFileError names the file and the directory it wasn't found in", () => {
  const error = new UntrackedFileError("missing-note.md", "/tmp/vault");
  assert.match(error.message, /missing-note\.md/);
  assert.match(error.message, /\/tmp\/vault/);
});
