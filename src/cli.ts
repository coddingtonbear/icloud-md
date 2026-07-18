#!/usr/bin/env node
import chalk from "chalk";
import cliProgress from "cli-progress";
import ora from "ora";
import { reauthenticateFolder, resolveFolderAccount } from "./auth/folderAuth.js";
import { parseSinceDuration, runBugReport, runBugReportIdentify } from "./commands/bugReport.js";
import { runClone, type CloneSummary } from "./commands/clone.js";
import { runDelete } from "./commands/delete.js";
import { runObjectDelete, runObjectList, runObjectShow } from "./commands/object.js";
import { runDiff } from "./commands/diff.js";
import { runHistory } from "./commands/history.js";
import { runPull, type PullSummary } from "./commands/pull.js";
import { runPush } from "./commands/push.js";
import { runRestore } from "./commands/restore.js";
import { runRevert } from "./commands/revert.js";
import { runStatus } from "./commands/status.js";
import { displayPath, findVaultRoot } from "./vaultRoot.js";
import { IcloudNotesSyncError, NotClonedDirectoryError } from "./errors.js";
import { recordLastError } from "./lastError.js";
import { readCloneState } from "./notes/cloneState.js";
import type { SyncProgress } from "./progress.js";

/**
 * Live terminal rendering for `clone`/`pull` progress - the only place ora
 * or cli-progress get constructed, so `runClone`/`runPull` stay usable as a
 * library without pulling terminal UI along with them.
 *
 * The spinner starts on `onFetchStart` (post-sign-in), never at construction:
 * sign-in can print status lines and even a first-run Chromium download's
 * progress (and its prompt lines), and a spinner running during that redraws
 * over whatever shares its row - it visually erased npx's "Ok to proceed?"
 * prompt, which presented as a silent first-run hang (2026-07-18).
 */
function makeSyncProgress(): SyncProgress {
  let fetchedCount = 0;
  let spinner: ReturnType<typeof ora> | undefined;
  const ensureSpinner = (): ReturnType<typeof ora> => (spinner ??= ora("Fetching notes from iCloud…").start());
  let bar: InstanceType<typeof cliProgress.SingleBar> | undefined;

  return {
    onFetchStart: () => {
      ensureSpinner();
    },
    onFetchPage: (recordsSoFar) => {
      fetchedCount = recordsSoFar;
      ensureSpinner().text = `Fetching notes from iCloud… (${fetchedCount} record(s) so far)`;
    },
    onProcessStart: (totalRecords) => {
      ensureSpinner().succeed(`Fetched ${fetchedCount} record(s) from iCloud`);
      bar = new cliProgress.SingleBar(
        {
          format: "Processing |{bar}| {value}/{total} notes",
          stream: process.stderr,
          hideCursor: true,
        },
        cliProgress.Presets.shades_classic,
      );
      bar.start(totalRecords, 0);
    },
    onRecordProcessed: () => {
      bar?.increment();
    },
    onProcessComplete: () => {
      bar?.stop();
    },
  };
}

function printCloneSummary(targetDir: string, summary: CloneSummary): void {
  console.log(
    `Cloned ${summary.written} notes (plus ${summary.writtenShared} shared with you) into ${targetDir}, ` +
      `${summary.attachmentsDownloaded} attachment(s) downloaded`,
  );
  if (summary.writtenUnpublishable > 0) {
    console.log(
      `${summary.writtenUnpublishable} note(s) written with content this tool couldn't fully parse - read-only`,
    );
  }
  console.log(`Skipped: ${summary.skippedDeleted} deleted, ${summary.skippedUndecodable} undecodable`);
}

function printPullSummary(targetDir: string, summary: PullSummary): void {
  console.log(
    `Pulled into ${targetDir}: ${summary.added} added, ${summary.updated} updated, ${summary.merged} auto-merged, ` +
      `${summary.removed} removed, ${summary.attachmentsDownloaded} attachment(s) downloaded`,
  );
  if (summary.unpublishable > 0) {
    console.log(
      `${summary.unpublishable} note(s) contain content this tool couldn't fully parse - read-only`,
    );
  }
  if (summary.skippedNewUnsyncable > 0 || summary.droppedUnsyncable > 0) {
    console.log(
      `${summary.skippedNewUnsyncable} new unsyncable note(s) skipped, ${summary.droppedUnsyncable} note(s) ` +
        "dropped from tracking (no longer syncable)",
    );
  }
  if (summary.unsharedUntracked > 0) {
    console.log(
      `${summary.unsharedUntracked} shared note(s) no longer shared with you - local copies left in place, untracked`,
    );
  }
  for (const notice of summary.notices) {
    (notice.level === "warn" ? console.warn : console.log)(notice.message);
  }
  if (summary.conflicts.length > 0) {
    console.log(`${summary.conflicts.length} conflict(s) - resolve manually:`);
    for (const conflict of summary.conflicts) {
      console.log(`  - ${conflict}`);
    }
  }
}

/** An explicit [directory] argument wins verbatim; otherwise walk up from
 * the current directory to find the enclosing vault, git-style. The "."
 * fallback keeps the not-a-cloned-directory error pointing at where the
 * user actually ran the command. */
async function resolveTargetDir(targetDirArg: string | undefined): Promise<string> {
  if (targetDirArg !== undefined) {
    return targetDirArg;
  }
  return (await findVaultRoot(process.cwd())) ?? ".";
}

async function verifyAuth(targetDirArg: string | undefined): Promise<void> {
  const targetDir = await resolveTargetDir(targetDirArg);
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const result = await resolveFolderAccount(targetDir, state.account, { onStatus: (message) => console.log(message) });

  console.log(`Authenticated as ${result.appleId}${result.fullName ? ` (${result.fullName})` : ""}`);
  console.log(`dsid: ${result.dsid}`);
  console.log(`Notes CloudKit host: ${result.ckdatabasewsUrl ?? "(not reported)"}`);
}

async function clone(targetDirArg: string | undefined): Promise<void> {
  if (!targetDirArg) {
    console.error("Usage: icloud-md clone <directory>");
    process.exitCode = 1;
    return;
  }
  const summary = await runClone(targetDirArg, makeSyncProgress(), (message) => console.log(message));
  printCloneSummary(targetDirArg, summary);
}

async function pull(targetDirArg: string | undefined): Promise<void> {
  const targetDir = await resolveTargetDir(targetDirArg);
  const summary = await runPull(targetDir, makeSyncProgress(), (message) => console.log(message));
  printPullSummary(targetDir, summary);
}

async function push(args: string[]): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const unknownFlag = flags.find((flag) => flag !== "--dry-run");
  if (unknownFlag || positional.length > 1) {
    console.error("Usage: icloud-md push [directory] [--dry-run]");
    process.exitCode = 1;
    return;
  }
  const targetDir = await resolveTargetDir(positional[0]);
  await runPush(targetDir, {
    dryRun: flags.includes("--dry-run"),
    onLoginStatus: (message) => console.log(message),
    formatPath: (file) => displayPath(targetDir, file),
  });
}

async function status(args: string[]): Promise<void> {
  if (args.length > 1) {
    console.error("Usage: icloud-md status [directory]");
    process.exitCode = 1;
    return;
  }
  const targetDir = await resolveTargetDir(args[0]);
  await runStatus(targetDir, {
    onLoginStatus: (message) => console.log(message),
    formatPath: (file) => displayPath(targetDir, file),
  });
}

async function restore(args: string[]): Promise<void> {
  const [fileArg, dirArg] = args;
  if (!fileArg) {
    console.error("Usage: icloud-md restore <file> [directory]");
    process.exitCode = 1;
    return;
  }
  await runRestore(await resolveTargetDir(dirArg), fileArg);
}

async function deleteNote(args: string[]): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const unknownFlag = flags.find((flag) => flag !== "--hard");
  const [fileArg, dirArg] = positional;
  if (unknownFlag || !fileArg || positional.length > 2) {
    console.error(
      "Usage: icloud-md delete <file> [directory] [--hard]\n" +
        "  Without --hard, moves the note to Recently Deleted (recoverable in Notes for ~30 days); " +
        "--hard permanently deletes it, including a note already soft-deleted by this tool.",
    );
    process.exitCode = 1;
    return;
  }
  await runDelete(await resolveTargetDir(dirArg), fileArg, {
    hard: flags.includes("--hard"),
    onLoginStatus: (message) => console.log(message),
  });
}

const OBJECT_USAGE =
  "Usage: icloud-md object <list|show|delete> ...\n" +
  "  object list [directory] [--type <recordType>] [--broken] [--orphaned] [--trashed] [--untracked] [--json]\n" +
  "      List every raw CloudKit record in the account's Notes zone (all types, including Attachment/Media\n" +
  "      records the sync path never fetches), with lifecycle state, references, local tracking, and - for\n" +
  "      notes - whether this tool can parse them (--broken shows only ones it can't).\n" +
  "  object show <recordName> [directory]\n" +
  "      Dump one record verbatim (all fields), plus the derived summary and every record referencing it\n" +
  "      (incomingReferences) - the \"who's in the way of deleting this?\" view.\n" +
  "  object delete <recordName> [directory] [--yes] [--force]\n" +
  "      Permanently delete one record by ID - the repair tool for broken objects. Notes use Apple's own\n" +
  "      two-stage purge (works on attachment-bearing and unparseable notes); other types use forceDelete.\n" +
  "      --force tombstones the record immediately via forceDelete instead, cascading over leaf-type\n" +
  "      referrers (attachments etc.) - for records whose content itself breaks Notes clients, since a\n" +
  "      purged record's fields stay in the sync stream until server GC. Deleting a Folder requires --yes.";

async function objectCommand(args: string[]): Promise<void> {
  const [subcommand, ...subArgs] = args;
  const flags = subArgs.filter((arg) => arg.startsWith("--"));
  const positional = subArgs.filter((arg, i) => !arg.startsWith("--") && subArgs[i - 1] !== "--type");
  const onLoginStatus = (message: string): void => console.log(message);

  switch (subcommand) {
    case "list": {
      const typeIndex = subArgs.indexOf("--type");
      const type = typeIndex !== -1 ? subArgs[typeIndex + 1] : undefined;
      const knownFlags = ["--type", "--broken", "--orphaned", "--trashed", "--untracked", "--json"];
      const unknownFlag = flags.find((flag) => !knownFlags.includes(flag));
      if (unknownFlag || (typeIndex !== -1 && (type === undefined || type.startsWith("--"))) || positional.length > 1) {
        console.error(OBJECT_USAGE);
        process.exitCode = 1;
        return;
      }
      await runObjectList(
        await resolveTargetDir(positional[0]),
        {
          type,
          broken: flags.includes("--broken"),
          orphaned: flags.includes("--orphaned"),
          trashed: flags.includes("--trashed"),
          untracked: flags.includes("--untracked"),
          json: flags.includes("--json"),
        },
        { onLoginStatus },
      );
      return;
    }
    case "show": {
      const [recordName, dirArg] = positional;
      if (flags.length > 0 || !recordName || positional.length > 2) {
        console.error(OBJECT_USAGE);
        process.exitCode = 1;
        return;
      }
      await runObjectShow(await resolveTargetDir(dirArg), recordName, { onLoginStatus });
      return;
    }
    case "delete": {
      const [recordName, dirArg] = positional;
      const unknownFlag = flags.find((flag) => flag !== "--yes" && flag !== "--force");
      if (unknownFlag || !recordName || positional.length > 2) {
        console.error(OBJECT_USAGE);
        process.exitCode = 1;
        return;
      }
      await runObjectDelete(await resolveTargetDir(dirArg), recordName, {
        yes: flags.includes("--yes"),
        force: flags.includes("--force"),
        onLoginStatus,
      });
      return;
    }
    default:
      console.error(OBJECT_USAGE);
      process.exitCode = 1;
  }
}

async function history(args: string[]): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const unknownFlag = flags.find((flag) => flag !== "--records");
  const [fileArg, dirArg] = positional;
  if (unknownFlag || !fileArg || positional.length > 2) {
    console.error(
      "Usage: icloud-md history <file> [directory] [--records]\n" +
        "  Without --records, shows the epoch timeline (one line per coordinated pull/push capture); " +
        "--records shows the flat per-record snapshot listing instead.",
    );
    process.exitCode = 1;
    return;
  }
  await runHistory(await resolveTargetDir(dirArg), fileArg, { records: flags.includes("--records") });
}

const DIFF_USAGE =
  "Usage: icloud-md diff <file> <ref> [directory]\n" +
  "  <ref> is a snapshot id (diffed against the current remote copy) or <from>..<to> (two snapshot ids) - " +
  'ids come from "icloud-md history <file>".';

async function diff(args: string[]): Promise<void> {
  const [fileArg, refArg, dirArg] = args;
  if (!fileArg || !refArg) {
    console.error(DIFF_USAGE);
    process.exitCode = 1;
    return;
  }

  const parts = refArg.split("..");
  let fromId: string;
  let toId: string | undefined;
  if (parts.length === 1 && parts[0]) {
    fromId = parts[0];
  } else if (parts.length === 2 && parts[0] && parts[1]) {
    [fromId, toId] = [parts[0], parts[1]];
  } else {
    console.error(`Invalid ref "${refArg}" - expected a snapshot id or <from>..<to>.\n${DIFF_USAGE}`);
    process.exitCode = 1;
    return;
  }

  await runDiff(await resolveTargetDir(dirArg), fileArg, fromId, toId, (message) => console.log(message));
}

async function revert(args: string[]): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const unknownFlag = flags.find((flag) => flag !== "--yes");
  const [fileArg, idArg, dirArg] = positional;
  if (unknownFlag || !fileArg || !idArg || positional.length > 3) {
    console.error(
      "Usage: icloud-md revert <file> <id> [directory] [--yes]\n" +
        "  Without --yes, reports what would happen without writing anything - this is a real remote write.",
    );
    process.exitCode = 1;
    return;
  }

  await runRevert(await resolveTargetDir(dirArg), fileArg, idArg, {
    confirmed: flags.includes("--yes"),
    onLoginStatus: (message) => console.log(message),
  });
}

const BUG_REPORT_USAGE =
  "Usage: icloud-md bug-report --since <duration> [directory]\n" +
  '  <duration> is a number followed by "m" (minutes), "h" (hours), or "d" (days) - e.g. 30m, 6h, 2d.\n' +
  "  A range is required rather than assumed, since the log is shared across every account used on this machine.\n" +
  "  Note titles, folder/sharer names, and the account's dsid/appleId are replaced with stable aliases in the\n" +
  "  report - see its \"Redacted identifiers\" section.\n" +
  "\n" +
  "Usage: icloud-md bug-report --identify <file> [directory]\n" +
  "  Prints the alias a bug report will use for <file>, so you can reference it (e.g. \"note-14\") without\n" +
  "  sharing its real title.";

async function bugReport(args: string[]): Promise<void> {
  const identifyIndex = args.indexOf("--identify");
  if (identifyIndex !== -1) {
    const fileArg = args[identifyIndex + 1];
    const positional = args.filter((_arg, index) => index !== identifyIndex && index !== identifyIndex + 1);
    if (!fileArg || positional.length > 1) {
      console.error(BUG_REPORT_USAGE);
      process.exitCode = 1;
      return;
    }
    await runBugReportIdentify(await resolveTargetDir(positional[0]), fileArg);
    return;
  }

  const sinceIndex = args.indexOf("--since");
  let since: Date | undefined;
  let positional = args;
  if (sinceIndex !== -1) {
    since = parseSinceDuration(args[sinceIndex + 1] ?? "");
    positional = args.filter((_arg, index) => index !== sinceIndex && index !== sinceIndex + 1);
  }

  const unknownFlag = positional.find((arg) => arg.startsWith("--"));
  if (!since || unknownFlag || positional.length > 1) {
    console.error(BUG_REPORT_USAGE);
    process.exitCode = 1;
    return;
  }

  await runBugReport(await resolveTargetDir(positional[0]), since);
}

async function reauthenticate(targetDirArg: string | undefined): Promise<void> {
  const targetDir = await resolveTargetDir(targetDirArg);
  console.log("Opening a browser window for iCloud sign-in...");
  const result = await reauthenticateFolder(targetDir, { onStatus: (message) => console.log(message) });
  console.log(`Reauthenticated as ${result.appleId} (dsid ${result.dsid}) for ${targetDir}.`);
}

/**
 * Known, "expected" failures (`IcloudNotesSyncError`) print just their
 * message/hint in red - no stack trace, since the user doesn't need one to
 * act on them. Anything else is a genuine bug: rethrowing here leaves Node's
 * default unhandled-rejection handler to print the full stack trace, which
 * is what keeps those debuggable.
 */
async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  try {
    switch (command) {
      case "reauthenticate":
        await reauthenticate(rest[0]);
        return;
      case "verify-auth":
        await verifyAuth(rest[0]);
        return;
      case "clone":
        await clone(rest[0]);
        return;
      case "pull":
        await pull(rest[0]);
        return;
      case "push":
        await push(rest);
        return;
      case "status":
        await status(rest);
        return;
      case "restore":
        await restore(rest);
        return;
      case "delete":
        await deleteNote(rest);
        return;
      case "object":
        await objectCommand(rest);
        return;
      case "history":
        await history(rest);
        return;
      case "diff":
        await diff(rest);
        return;
      case "revert":
        await revert(rest);
        return;
      case "bug-report":
        await bugReport(rest);
        return;
      default:
        console.error(
          "Usage: icloud-md <command>\n\n" +
            "Commands:\n" +
            "  clone <directory>     Fetch all Notes into a fresh local directory; signs in via a browser window " +
            "the first time a directory (or a new account) is used\n" +
            "  pull [directory]      Fetch changes since the last clone/pull (defaults to the current directory)\n" +
            "  push [directory]      Reconcile local disk state up to iCloud: creates notes for new .md files, " +
            "uploads edited notes, moves notes whose file was removed locally to Recently Deleted, and merges in " +
            'remote changes to a note edited both places (--dry-run to preview). Run "status" first to see exactly ' +
            "what push will do, including anything it would refuse.\n" +
            "  status [directory]    Preview exactly what the next push will do - creates, deletes, changes, and " +
            "any refusals - using the same live check push --dry-run performs (requires signing in)\n" +
            "  restore <file> [directory]  Discard a tracked note's local edits, reverting it to the last synced copy\n" +
            "  delete <file> [directory] [--hard]  Move a tracked note to Recently Deleted (a real remote write, no " +
            "confirmation prompt) and stop tracking it locally; a locally-edited copy is kept on disk (untracked) " +
            "rather than discarded. --hard permanently deletes instead - works on attachment-bearing and even " +
            "unparseable notes, and on a note this tool already soft-deleted\n" +
            "  object <list|show|delete>  Record-level plumbing: inspect and permanently delete raw CloudKit objects " +
            'by ID - the repair kit for broken note objects. Run "icloud-md object" for details\n' +
            "  history <file> [directory] [--records]  List a note's epoch timeline, newest first (--records for the " +
            "flat per-record snapshot listing instead)\n" +
            "  diff <file> <ref> [directory]  Diff two snapshots, or one snapshot against the current remote copy - " +
            "<ref> is a snapshot id or <from>..<to>\n" +
            "  revert <file> <id> [directory] [--yes]  Write a historical snapshot back to the server (a real remote " +
            "write - without --yes, reports what would happen)\n" +
            "  reauthenticate [directory]  Force a fresh sign-in for a directory's already-bound account (defaults to the current directory)\n" +
            "  verify-auth [directory]     Check whether a directory's bound account is authenticated (defaults to the current directory)\n" +
            "  bug-report --since <duration> [directory]  Bundle version info, the last error, local state, and " +
            "debug-log entries from the given duration (e.g. 1h, 2d) into a file to attach to a GitHub issue - " +
            "note titles, folder/sharer names, and the account's dsid/appleId are replaced with stable aliases\n" +
            "  bug-report --identify <file> [directory]  Print the alias (e.g. \"note-14\") a bug report will use " +
            "for <file>, to reference it without sharing its real title",
        );
        process.exitCode = 1;
    }
  } catch (error) {
    // Best-effort: a failure to persist this shouldn't mask the real error below.
    await recordLastError(error).catch(() => {});

    if (error instanceof IcloudNotesSyncError) {
      console.error(chalk.red(error.message));
      if (error.hint) {
        console.error(chalk.red(error.hint));
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

await main();
