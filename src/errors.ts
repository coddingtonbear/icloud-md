export interface IcloudNotesSyncErrorOptions extends ErrorOptions {
  hint?: string;
}

/**
 * Base for known, "expected" failure modes - a library consumer can catch
 * this broadly to distinguish them from genuine bugs, while the CLI prints
 * `message` (and `hint`, if present) without a stack trace. Anything not an
 * instance of this stays a plain `Error` and keeps its raw stack trace, since
 * that means something actually went wrong that needs debugging.
 */
export class IcloudNotesSyncError extends Error {
  readonly hint?: string;

  constructor(message: string, options: IcloudNotesSyncErrorOptions = {}) {
    super(message, options);
    this.name = new.target.name;
    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
  }
}

export class AuthenticationExpiredError extends IcloudNotesSyncError {
  constructor(status: number, detail: string) {
    super(`Not authenticated (HTTP ${status}): ${detail}`, {
      hint: 'Run "icloud-notes reauthenticate" to sign in again.',
    });
  }
}

/**
 * Covers both the headless-recovery attempt throwing outright, and the case
 * where recovery "succeeded" but the resulting session still fails
 * verification - either way, the persistent browser profile can't get back
 * in on its own and a human needs to complete an interactive sign-in.
 */
export class SilentReauthFailedError extends IcloudNotesSyncError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, {
      ...options,
      hint: 'Run "icloud-notes reauthenticate" to sign in interactively.',
    });
  }
}

export class UntrackedFileError extends IcloudNotesSyncError {
  constructor(fileName: string, targetDir: string, options: { hint?: string } = {}) {
    super(`"${fileName}" isn't a tracked note in ${targetDir}.`, {
      hint: options.hint ?? "Check the file name (it's case-sensitive) and try again.",
    });
  }
}

export class NotClonedDirectoryError extends IcloudNotesSyncError {
  constructor(targetDir: string) {
    super(`${targetDir} doesn't look like a cloned notes directory (no .icloud-notes-sync/state.json).`, {
      hint: 'Run "icloud-notes clone <directory>" first.',
    });
  }
}

export class MissingSessionFileError extends IcloudNotesSyncError {
  constructor(sessionPath: string, options: ErrorOptions = {}) {
    super(`No session file found at ${sessionPath}.`, {
      ...options,
      hint: 'Run "icloud-notes reauthenticate" (or "npm run import-har -- <path-to.har>" from a browser HAR export) to create one.',
    });
  }
}

/** The session file exists but isn't (or is no longer) a valid `IcloudSession` - hand-edited, truncated, or from an incompatible version. */
export class CorruptSessionFileError extends IcloudNotesSyncError {
  constructor(message: string) {
    super(message, { hint: 'Run "icloud-notes reauthenticate" to regenerate it.' });
  }
}

export class ChromiumNotInstalledError extends IcloudNotesSyncError {
  constructor(options: ErrorOptions = {}) {
    super("Could not launch the login browser.", {
      ...options,
      hint: 'Playwright\'s Chromium may not be installed yet - run "npx playwright install chromium" and retry.',
    });
  }
}

/** Covers every way an interactive/headless browser login can end without a usable session: no cookies captured, the wait timed out, or the window was closed early. */
export class SignInIncompleteError extends IcloudNotesSyncError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, {
      ...options,
      hint: "Try again and complete the sign-in (including any 2FA prompt) without closing the browser window.",
    });
  }
}

export class NotesUnavailableError extends IcloudNotesSyncError {
  constructor() {
    super("Authenticated, but the account reported no ckdatabasews host - can't reach Notes.", {
      hint: "Check that Notes is enabled for this Apple ID (icloud.com → Notes) and try again.",
    });
  }
}

/** A tracked directory's `.icloud-notes-sync/state.json` doesn't match the shape `clone`/`pull`/`push` produce - hand-edited, truncated, or from an incompatible version. */
export class CorruptStateFileError extends IcloudNotesSyncError {
  constructor(message: string) {
    super(message, {
      hint:
        "This usually means state.json was hand-edited or written by an incompatible version. If you don't have " +
        "local edits worth preserving, remove .icloud-notes-sync/ and run \"icloud-notes clone\" again into a fresh directory.",
    });
  }
}

/** `clone` only ever performs the initial export into a directory - mirrors `git clone`'s own refusal to run against a non-empty destination. */
export class AlreadyClonedDirectoryError extends IcloudNotesSyncError {
  constructor(targetDir: string) {
    super(`${targetDir} is already a cloned notes directory (.icloud-notes-sync/state.json exists).`, {
      hint: 'Run "icloud-notes pull" instead to fetch changes into an existing clone.',
    });
  }
}

/** A folder's state.json predates per-folder account binding (or was hand-edited to drop it) - there's no account to resolve a session for. */
export class UnboundAccountError extends IcloudNotesSyncError {
  constructor(targetDir: string) {
    super(`${targetDir} has no account bound to it (missing "account" in .icloud-notes-sync/state.json).`, {
      hint:
        "This folder may predate per-folder account binding. If you don't have local edits worth preserving, " +
        'remove .icloud-notes-sync/ and run "icloud-notes clone" again into a fresh directory.',
    });
  }
}

/**
 * A folder is bound to one Apple ID, but the session just authenticated (via
 * `reauthenticate`, or headless 421 recovery) is for a different one. Refuses
 * rather than silently rebinding the folder to a new account - that would
 * risk `pull`/`push` quietly mixing one person's notes into another's vault.
 */
export class AccountMismatchError extends IcloudNotesSyncError {
  constructor(targetDir: string, expectedAppleId: string, actualAppleId: string) {
    super(`${targetDir} was cloned for ${expectedAppleId}, but the session just authenticated is for ${actualAppleId}.`, {
      hint: `Sign in as ${expectedAppleId} to continue working with this folder.`,
    });
  }
}

/**
 * A CloudKit/network request came back non-OK with only an HTTP status to go
 * on - could be a transient network or service blip, could be a real
 * protocol-level bug. There's no specific fix to point at either way, so the
 * hint stays generic; the message keeps the operation/status detail for
 * anyone filing an issue.
 */
export class CloudKitRequestFailedError extends IcloudNotesSyncError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, {
      ...options,
      hint:
        "This may be a transient network or iCloud-service issue - wait a moment and try again. If it keeps " +
        "happening, please open a GitHub issue including this message.",
    });
  }
}

/** A `history`/`diff`/`revert` snapshot id that doesn't match any recorded
 * version for the given file - either mistyped, or from a different file's
 * history. */
export class UnknownVersionSnapshotError extends IcloudNotesSyncError {
  constructor(id: string, fileName: string) {
    super(`No version snapshot with id "${id}" found for "${fileName}".`, {
      hint: `Run "icloud-notes history ${fileName}" to see available snapshot ids.`,
    });
  }
}

/** `delete` fetched a fresh recordChangeTag immediately before writing, so a
 * rejection here means something changed the note in that narrow window
 * (or a genuine CloudKit-side problem) rather than the stale-tag conflict
 * `push` routinely expects. */
export class NoteDeleteRejectedError extends IcloudNotesSyncError {
  constructor(fileName: string, serverErrorCode: string, reason: string | undefined) {
    const detail = reason ? ` (${reason})` : "";
    super(`Can't delete "${fileName}": the server rejected it: ${serverErrorCode}${detail}.`, {
      hint: 'Run "icloud-notes pull" to refresh local state, then try again.',
    });
  }
}

/** `object show`/`object delete` looked up a recordName that doesn't
 * resolve to anything in the zone. */
export class UnknownObjectError extends IcloudNotesSyncError {
  constructor(recordName: string, options: { maybeDeleted?: boolean } = {}) {
    super(`No object named "${recordName}" exists in the Notes zone.`, {
      hint: options.maybeDeleted
        ? 'It may already be permanently deleted. Run "icloud-notes object list" to see what exists.'
        : 'Run "icloud-notes object list" to see what exists (recordNames are case-sensitive).',
    });
  }
}

/** `object delete --force` found the target blocked by referrers it won't
 * cascade into: a Folder or another Note is collateral, not per-note
 * cleanup, so it stops and names them instead. */
export class ObjectForceDeleteBlockedError extends IcloudNotesSyncError {
  constructor(recordName: string, blockers: readonly { recordName: string; recordType: string }[]) {
    const listed = blockers.map((blocker) => `${blocker.recordType} ${blocker.recordName}`).join(", ");
    super(`Can't force-delete "${recordName}": it's referenced by record(s) --force won't delete for you: ${listed}.`, {
      hint: 'Delete those explicitly first ("icloud-notes object delete <recordName>") if you really mean to, then retry.',
    });
  }
}

/** Deleting a structural record (a Folder) detaches everything under it -
 * unlike a Note or Attachment, where naming the ID is intent enough, this
 * needs an explicit --yes. */
export class ObjectDeleteNeedsConfirmationError extends IcloudNotesSyncError {
  constructor(recordType: string, recordName: string) {
    super(`Deleting a ${recordType} record affects everything under it, not just the record itself.`, {
      hint: `Re-run with --yes if you really mean it: "icloud-notes object delete ${recordName} --yes".`,
    });
  }
}

/** `diff`/`revert` couldn't read the content needed on one side of the
 * comparison (or write-back) - the target record vanished remotely, is no
 * longer in a readable state, or a historical snapshot no longer decodes
 * cleanly against the current model. */
export class VersionContentUnavailableError extends IcloudNotesSyncError {
  constructor(reason: string) {
    super(`Can't complete this operation: ${reason}.`, {
      hint: 'Run "icloud-notes pull" to refresh local state, then try again.',
    });
  }
}
