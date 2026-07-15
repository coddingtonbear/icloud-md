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
      hint: 'Run "icloud-notes login" to sign in again.',
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
      hint: 'Run "icloud-notes login" to sign in interactively.',
    });
  }
}

export class UntrackedFileError extends IcloudNotesSyncError {
  constructor(fileName: string, targetDir: string) {
    super(`"${fileName}" isn't a tracked note in ${targetDir}.`, {
      hint: "Check the file name (it's case-sensitive) and try again.",
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
      hint: 'Run "icloud-notes login" (or "npm run import-har -- <path-to.har>" from a browser HAR export) to create one.',
    });
  }
}

/** The session file exists but isn't (or is no longer) a valid `IcloudSession` - hand-edited, truncated, or from an incompatible version. */
export class CorruptSessionFileError extends IcloudNotesSyncError {
  constructor(message: string) {
    super(message, { hint: 'Run "icloud-notes login" to regenerate it.' });
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
      hint: 'Run "icloud-notes login" again and complete the sign-in (including any 2FA prompt) without closing the browser window.',
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
