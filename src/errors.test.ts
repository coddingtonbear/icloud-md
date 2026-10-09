import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountMismatchError,
  AlreadyClonedDirectoryError,
  AuthenticationExpiredError,
  BrowserExecutableLaunchError,
  BrowserExecutableNotFoundError,
  ChromiumNotInstalledError,
  CloudKitRequestFailedError,
  CorruptSessionFileError,
  CorruptStateFileError,
  IcloudNotesSyncError,
  InvalidBrowserExecutableError,
  isBrowserUnavailableError,
  summarizeBrowserLaunchFailure,
  MissingSessionFileError,
  NotClonedDirectoryError,
  NotesUnavailableError,
  SignInIncompleteError,
  SilentReauthFailedError,
  UnboundAccountError,
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
    new AlreadyClonedDirectoryError("/some/dir"),
    new UnboundAccountError("/some/dir"),
    new AccountMismatchError("/some/dir", "me@example.com", "someone-else@example.com"),
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
  assert.match(error.hint ?? "", /reauthenticate/);
});

test("NotClonedDirectoryError names the offending directory and points at `clone`", () => {
  const error = new NotClonedDirectoryError("/tmp/not-a-vault");
  assert.match(error.message, /\/tmp\/not-a-vault/);
  assert.match(error.hint ?? "", /clone/);
});

test("MissingSessionFileError names the session path and points at `reauthenticate`", () => {
  const error = new MissingSessionFileError("/home/user/.config/icloud-md/accounts/1234/session.local.json");
  assert.match(error.message, /session\.local\.json/);
  assert.match(error.hint ?? "", /reauthenticate/);
});

test("MissingSessionFileError preserves the underlying fs error as `cause`", () => {
  const cause = new Error("ENOENT");
  const error = new MissingSessionFileError("/some/path", { cause });
  assert.equal(error.cause, cause);
});

test("ChromiumNotInstalledError points at the playwright install command", () => {
  const error = new ChromiumNotInstalledError();
  assert.match(error.hint ?? "", /icloud-md install-browser/);
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

test("AlreadyClonedDirectoryError names the directory and points at `pull`", () => {
  const error = new AlreadyClonedDirectoryError("/tmp/vault");
  assert.match(error.message, /\/tmp\/vault/);
  assert.match(error.message, /already a cloned notes directory/);
  assert.match(error.hint ?? "", /pull/);
});

test("UnboundAccountError names the directory and points at re-cloning", () => {
  const error = new UnboundAccountError("/tmp/vault");
  assert.match(error.message, /\/tmp\/vault/);
  assert.match(error.message, /no account bound/);
  assert.match(error.hint ?? "", /clone/);
});

test("AccountMismatchError names the directory and both Apple IDs", () => {
  const error = new AccountMismatchError("/tmp/vault", "me@example.com", "someone-else@example.com");
  assert.match(error.message, /\/tmp\/vault/);
  assert.match(error.message, /me@example\.com/);
  assert.match(error.message, /someone-else@example\.com/);
  assert.match(error.hint ?? "", /me@example\.com/);
});

test("summarizeBrowserLaunchFailure keeps Playwright's summary line plus the browser's own stderr", () => {
  const message = [
    "browserType.launchPersistentContext: Target page, context or browser has been closed",
    "Browser logs:",
    "",
    "<launching> /opt/google/chrome/chrome --disable-field-trial-config",
    "<launched> pid=4242",
    "[pid=4242][err] /opt/google/chrome/chrome: error while loading shared libraries: libatk-1.0.so.0: cannot open",
    "[pid=4242][err] /opt/google/chrome/chrome: error while loading shared libraries: libatk-1.0.so.0: cannot open",
    "[pid=4242][err] ",
    "Call log:",
    "  - <launching> /opt/google/chrome/chrome",
  ].join("\n");
  assert.equal(
    summarizeBrowserLaunchFailure(message),
    "browserType.launchPersistentContext: Target page, context or browser has been closed\n" +
      "Browser output:\n" +
      "  /opt/google/chrome/chrome: error while loading shared libraries: libatk-1.0.so.0: cannot open",
  );
  assert.equal(summarizeBrowserLaunchFailure("Executable doesn't exist at /x\nCall log:\n  - foo"), "Executable doesn't exist at /x");
});

test("BrowserExecutableLaunchError names the executable and carries the browser's stderr into its message", () => {
  const cause = new Error("launch failed\n[pid=1][err] sandbox: Operation not permitted");
  const error = new BrowserExecutableLaunchError("/usr/bin/chromium", { cause });
  assert.match(error.message, /^Could not launch the browser at \/usr\/bin\/chromium: launch failed/);
  assert.match(error.message, /sandbox: Operation not permitted/);
  assert.equal(error.cause, cause);
  assert.match(error.hint ?? "", /--browser-executable/);
});

test("isBrowserUnavailableError covers every way the browser itself can be the problem, and nothing else", () => {
  assert.equal(isBrowserUnavailableError(new ChromiumNotInstalledError()), true);
  assert.equal(isBrowserUnavailableError(new InvalidBrowserExecutableError("chromium")), true);
  assert.equal(isBrowserUnavailableError(new BrowserExecutableNotFoundError("/x", "does not exist")), true);
  assert.equal(isBrowserUnavailableError(new BrowserExecutableLaunchError("/x")), true);
  assert.equal(isBrowserUnavailableError(new SilentReauthFailedError("timed out")), false);
  assert.equal(isBrowserUnavailableError(new Error("timed out")), false);
  assert.equal(isBrowserUnavailableError("timed out"), false);
});
