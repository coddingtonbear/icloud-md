#!/usr/bin/env node
import chalk from "chalk";
import cliProgress from "cli-progress";
import ora from "ora";
import { reauthenticateFolder, resolveFolderAccount } from "./auth/folderAuth.js";
import { runClone, type CloneSummary } from "./commands/clone.js";
import { runPull, type PullSummary } from "./commands/pull.js";
import { runPush } from "./commands/push.js";
import { runRestore } from "./commands/restore.js";
import { IcloudNotesSyncError, NotClonedDirectoryError } from "./errors.js";
import { readCloneState } from "./notes/cloneState.js";
import type { SyncProgress } from "./progress.js";

/**
 * Live terminal rendering for `clone`/`pull` progress - the only place ora
 * or cli-progress get constructed, so `runClone`/`runPull` stay usable as a
 * library without pulling terminal UI along with them.
 */
function makeSyncProgress(): SyncProgress {
  let fetchedCount = 0;
  const spinner = ora("Fetching notes from iCloud…").start();
  let bar: InstanceType<typeof cliProgress.SingleBar> | undefined;

  return {
    onFetchPage: (recordsSoFar) => {
      fetchedCount = recordsSoFar;
      spinner.text = `Fetching notes from iCloud… (${fetchedCount} record(s) so far)`;
    },
    onProcessStart: (totalRecords) => {
      spinner.succeed(`Fetched ${fetchedCount} record(s) from iCloud`);
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

async function verifyAuth(targetDirArg: string | undefined): Promise<void> {
  const targetDir = targetDirArg ?? ".";
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
    console.error("Usage: icloud-notes clone <directory>");
    process.exitCode = 1;
    return;
  }
  const summary = await runClone(targetDirArg, makeSyncProgress(), (message) => console.log(message));
  printCloneSummary(targetDirArg, summary);
}

async function pull(targetDirArg: string | undefined): Promise<void> {
  const targetDir = targetDirArg ?? ".";
  const summary = await runPull(targetDir, makeSyncProgress(), (message) => console.log(message));
  printPullSummary(targetDir, summary);
}

async function push(args: string[]): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const unknownFlag = flags.find((flag) => flag !== "--dry-run");
  if (unknownFlag || positional.length > 1) {
    console.error("Usage: icloud-notes push [directory] [--dry-run]");
    process.exitCode = 1;
    return;
  }
  await runPush(positional[0] ?? ".", {
    dryRun: flags.includes("--dry-run"),
    onLoginStatus: (message) => console.log(message),
  });
}

async function restore(args: string[]): Promise<void> {
  const [fileArg, dirArg] = args;
  if (!fileArg) {
    console.error("Usage: icloud-notes restore <file> [directory]");
    process.exitCode = 1;
    return;
  }
  await runRestore(dirArg ?? ".", fileArg);
}

async function reauthenticate(targetDirArg: string | undefined): Promise<void> {
  const targetDir = targetDirArg ?? ".";
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
      case "restore":
        await restore(rest);
        return;
      default:
        console.error(
          "Usage: icloud-notes <command>\n\n" +
            "Commands:\n" +
            "  clone <directory>     Fetch all Notes into a fresh local directory; signs in via a browser window " +
            "the first time a directory (or a new account) is used\n" +
            "  pull [directory]      Fetch changes since the last clone/pull (defaults to the current directory)\n" +
            "  push [directory]      Upload locally edited notes (--dry-run to preview); conflicts are reported, never overwritten\n" +
            "  restore <file> [directory]  Discard a tracked note's local edits, reverting it to the last synced copy\n" +
            "  reauthenticate [directory]  Force a fresh sign-in for a directory's already-bound account (defaults to the current directory)\n" +
            "  verify-auth [directory]     Check whether a directory's bound account is authenticated (defaults to the current directory)",
        );
        process.exitCode = 1;
    }
  } catch (error) {
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
