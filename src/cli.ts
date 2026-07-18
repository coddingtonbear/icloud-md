#!/usr/bin/env node
import chalk from "chalk";
import cliProgress from "cli-progress";
import { Command, CommanderError } from "commander";
import ora from "ora";
import { reauthenticateFolder, resolveFolderAccount } from "./auth/folderAuth.js";
import { DISCLOSURE_WARNING, parseSinceDuration, runBugReport, runBugReportIdentify } from "./commands/bugReport.js";
import { runClone, type CloneSummary } from "./commands/clone.js";
import { renderDeleteResult, runDelete } from "./commands/delete.js";
import { renderDiffResult, runDiff } from "./commands/diff.js";
import { runHistory, type HistoryResult } from "./commands/history.js";
import {
  renderObjectDeleteResult,
  renderObjectList,
  runObjectDelete,
  runObjectList,
  runObjectShow,
  type ObjectShowResult,
} from "./commands/object.js";
import { runPull, type PullSummary } from "./commands/pull.js";
import { runPush } from "./commands/push.js";
import { runRestore } from "./commands/restore.js";
import { renderRevertResult, runRevert } from "./commands/revert.js";
import { runStatus } from "./commands/status.js";
import { createOutputContext, emitError, emitResult, emitUsageError, makeStatusSink, type OutputContext } from "./cli/output.js";
import { NotClonedDirectoryError } from "./errors.js";
import { recordLastError } from "./lastError.js";
import { readCloneState } from "./notes/cloneState.js";
import { renderPlan } from "./notes/pushPlan.js";
import { displayPath, findVaultRoot } from "./vaultRoot.js";
import type { SyncProgress } from "./progress.js";

/**
 * `--json` mode's progress renderer: one stable, greppable line per event on
 * stderr (`icloud-md:progress:...`), newline-terminated and never redrawn in
 * place - unlike ora/cli-progress, which redraw the same terminal row via
 * carriage returns and are only meaningful to a human watching live. This is
 * for a wrapping process (e.g. the obsidian-icloud plugin, which shells out
 * to this CLI) to get coarse progress by splitting stderr on newlines and
 * matching the `icloud-md:progress:` prefix, without depending on ora/
 * cli-progress's exact redraw behavior or wording. stdout stays pure JSON
 * either way.
 */
function makeMachineSyncProgress(): SyncProgress {
  let processed = 0;
  let total = 0;
  return {
    onFetchPage: (recordsSoFar) => {
      console.error(`icloud-md:progress:fetch:${recordsSoFar}`);
    },
    onProcessStart: (totalRecords) => {
      total = totalRecords;
      console.error(`icloud-md:progress:process-start:${total}`);
    },
    onRecordProcessed: () => {
      processed += 1;
      console.error(`icloud-md:progress:process:${processed}/${total}`);
    },
    onProcessComplete: () => {
      console.error(`icloud-md:progress:process-done`);
    },
  };
}

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
 *
 * Both ora and cli-progress already target stderr unconditionally (ora
 * defaults there; the bar is constructed with `stream: process.stderr`
 * below). Only used for a human terminal, though: `--json` mode has no
 * interactive display to draw on, so it uses `makeMachineSyncProgress`
 * instead - see that function for why.
 */
function makeHumanSyncProgress(): SyncProgress {
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

function makeSyncProgress(context: OutputContext): SyncProgress {
  return context.json ? makeMachineSyncProgress() : makeHumanSyncProgress();
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

function printHistoryResult(result: HistoryResult): void {
  if (result.mode === "records") {
    if (result.records.length === 0) {
      console.log("No version history recorded yet.");
      return;
    }
    for (const row of result.records) {
      console.log(`${row.id}  ${row.timestamp}  ${row.label}  (changeTag ${row.recordChangeTag})`);
    }
    return;
  }
  if (result.epochs.length === 0) {
    console.log("No version history recorded yet.");
    return;
  }
  for (const epoch of result.epochs) {
    let line = `${epoch.id}  ${epoch.timestamp}  changed: ${epoch.changed.join(", ")}`;
    if (epoch.carriedOver.length > 0) {
      line += `  (carried over: ${epoch.carriedOver.join(", ")})`;
    }
    console.log(line);
  }
}

/** The one place a new human-readable view is added rather than preserved -
 * `object show` previously always dumped its full JSON verbatim. */
function printObjectShowSummary(result: ObjectShowResult): void {
  const created = result.createdAt !== undefined ? new Date(result.createdAt).toISOString() : undefined;
  const modified = result.modifiedAt !== undefined ? new Date(result.modifiedAt).toISOString() : undefined;
  console.log(`${result.recordType} ${result.recordName}`);
  console.log(`  state: ${result.state}`);
  if (created || modified) {
    console.log(`  created: ${created ?? "-"}   modified: ${modified ?? "-"}`);
  }
  if (result.title !== undefined) {
    console.log(`  title: "${result.title}"`);
  }
  if (result.trackedFile !== undefined) {
    console.log(`  tracked file: ${result.trackedFile}`);
  }
  if (result.health !== undefined && result.health !== "ok") {
    console.log(chalk.magenta(`  ! ${result.health}`));
  }
  console.log(
    `  references (${result.references.length}): ${result.references.length > 0 ? result.references.join(", ") : "none"}`,
  );
  if (result.incomingReferences.length === 0) {
    console.log(`  referenced by: none`);
  } else {
    console.log(`  referenced by (${result.incomingReferences.length}):`);
    for (const ref of result.incomingReferences) {
      console.log(`    ${ref.recordType} ${ref.recordName}${ref.title ? ` ("${ref.title}")` : ""} [${ref.state}]`);
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

/** Every action reads the merged `--json` flag (global, so it works
 * whether it's given before or after a subcommand name) via this helper. */
function contextFor(command: Command): OutputContext {
  const opts = command.optsWithGlobals() as { json?: boolean };
  return createOutputContext(opts.json === true);
}

// `--json` is scanned directly from argv (rather than waiting for commander
// to parse it) so a usage error - which can happen before or instead of
// normal option parsing - still knows which mode to report in.
const preParsedJson = process.argv.includes("--json");

const program = new Command();
program
  .name("icloud-md")
  .description("Your iCloud notes as real Markdown files, on any OS, bidirectionally synced with a git-flavored CLI")
  .option("--json", "emit machine-readable JSON on stdout instead of human-readable text")
  .exitOverride();

// In `--json` mode, commander's own plain-text usage-error output would land
// on stdout's neighbor stream unstructured; suppressed here so the top-level
// catch below can report the same failure as structured JSON instead. Human
// mode leaves commander's own formatting untouched. Configured before any
// subcommand is created so `.command()`'s settings inheritance carries it
// down to every subcommand, including `object`'s.
if (preParsedJson) {
  program.configureOutput({ writeErr: () => {} });
}

program.action(() => {
  program.help({ error: true });
});

program
  .command("clone <directory>")
  .description(
    "Fetch all Notes into a fresh local directory; signs in via a browser window the first time a directory " +
      "(or a new account) is used",
  )
  .action(async (directory: string, _opts: unknown, command: Command) => {
    const context = contextFor(command);
    const summary = await runClone(directory, makeSyncProgress(context), makeStatusSink(context));
    emitResult(context, summary, (result) => printCloneSummary(directory, result));
  });

program
  .command("pull [directory]")
  .description("Fetch changes since the last clone/pull (defaults to the current directory)")
  .action(async (directory: string | undefined, _opts: unknown, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const summary = await runPull(targetDir, makeSyncProgress(context), makeStatusSink(context));
    emitResult(context, summary, (result) => printPullSummary(targetDir, result));
  });

program
  .command("push [directory]")
  .description(
    "Reconcile local disk state up to iCloud: creates notes for new .md files, uploads edited notes, moves notes " +
      "whose file was removed locally to Recently Deleted, and merges in remote changes to a note edited both " +
      'places. Run "status" first to see exactly what push will do, including anything it would refuse.',
  )
  .option("--dry-run", "report what would be pushed without changing anything")
  .action(async (directory: string | undefined, opts: { dryRun?: boolean }, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const result = await runPush(targetDir, { dryRun: opts.dryRun === true, onLoginStatus: makeStatusSink(context) });
    emitResult(context, result, (r) => {
      for (const entry of r.entries) {
        if (entry.outcome) {
          console.log(entry.outcome.succeeded ? entry.outcome.message : chalk.red(entry.outcome.message));
        }
      }
      if (r.pushed !== undefined) {
        console.log(`Pushed ${r.pushed} note(s) from ${targetDir}`);
      }
      for (const line of renderPlan(r.entries, (file) => displayPath(targetDir, file))) {
        console.log(line);
      }
    });
    if (result.dryRun && result.entries.length > 0) {
      process.exitCode = 3;
    }
  });

program
  .command("status [directory]")
  .description(
    "Preview exactly what the next push will do - creates, deletes, changes, and any refusals - using the same " +
      "live check push --dry-run performs (requires signing in)",
  )
  .action(async (directory: string | undefined, _opts: unknown, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const result = await runStatus(targetDir, { onLoginStatus: makeStatusSink(context) });
    emitResult(context, result, (r) => {
      for (const line of renderPlan(r.entries, (file) => displayPath(targetDir, file))) {
        console.log(line);
      }
    });
    if (result.entries.length > 0) {
      process.exitCode = 3;
    }
  });

program
  .command("restore <file> [directory]")
  .description("Discard a tracked note's local edits, reverting it to the last synced copy")
  .action(async (file: string, directory: string | undefined, _opts: unknown, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const result = await runRestore(targetDir, file);
    emitResult(context, result, (r) => console.log(`Restored ${r.file} to match the last synced copy.`));
  });

program
  .command("delete <file> [directory]")
  .description(
    "Move a tracked note to Recently Deleted (a real remote write, no confirmation prompt) and stop tracking it " +
      "locally; a locally-edited copy is kept on disk (untracked) rather than discarded.",
  )
  .option("--hard", "permanently delete instead - works even on an already soft-deleted or unparseable note")
  .action(async (file: string, directory: string | undefined, opts: { hard?: boolean }, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const result = await runDelete(targetDir, file, { hard: opts.hard === true, onLoginStatus: makeStatusSink(context) });
    emitResult(context, result, (r) => console.log(renderDeleteResult(r)));
  });

const objectCommand = program
  .command("object")
  .description(
    "Record-level plumbing: inspect and permanently delete raw CloudKit objects by ID - the repair kit for " +
      "broken note objects",
  );

objectCommand
  .command("list [directory]")
  .description(
    "List every raw CloudKit record in the account's Notes zone (all types, including Attachment/Media records " +
      "the sync path never fetches), with lifecycle state, references, local tracking, and - for notes - whether " +
      "this tool can parse them",
  )
  .option("--type <recordType>", "filter to one record type")
  .option("--broken", "show only notes this tool can't parse")
  .option("--orphaned", "show only records referencing something that no longer exists")
  .option("--trashed", "show only trashed/purged records")
  .option("--untracked", "show only live notes this tool isn't tracking")
  .action(
    async (
      directory: string | undefined,
      opts: { type?: string; broken?: boolean; orphaned?: boolean; trashed?: boolean; untracked?: boolean },
      command: Command,
    ) => {
      const context = contextFor(command);
      const targetDir = await resolveTargetDir(directory);
      const result = await runObjectList(targetDir, opts, { onLoginStatus: makeStatusSink(context) });
      emitResult(context, result, (list) => {
        for (const line of renderObjectList(list)) {
          console.log(line);
        }
      });
    },
  );

objectCommand
  .command("show <recordName> [directory]")
  .description(
    "Dump one record's derived summary, every field, and every record referencing it (incomingReferences) - the " +
      '"who\'s in the way of deleting this?" view',
  )
  .action(async (recordName: string, directory: string | undefined, _opts: unknown, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const result = await runObjectShow(targetDir, recordName, { onLoginStatus: makeStatusSink(context) });
    emitResult(context, result, printObjectShowSummary);
  });

objectCommand
  .command("delete <recordName> [directory]")
  .description(
    "Permanently delete one record by ID. Notes use Apple's own two-stage purge (works on attachment-bearing and " +
      "unparseable notes); other types use forceDelete. Deleting a Folder requires --yes.",
  )
  .option("--yes", "confirm deleting a structural record (a Folder)")
  .option(
    "--force",
    "tombstone the record immediately via forceDelete, cascading over leaf-type referrers (attachments etc.) - " +
      "for records whose content itself breaks Notes clients",
  )
  .action(
    async (recordName: string, directory: string | undefined, opts: { yes?: boolean; force?: boolean }, command: Command) => {
      const context = contextFor(command);
      const targetDir = await resolveTargetDir(directory);
      const result = await runObjectDelete(targetDir, recordName, {
        yes: opts.yes === true,
        force: opts.force === true,
        onLoginStatus: makeStatusSink(context),
      });
      emitResult(context, result, (r) => {
        for (const line of renderObjectDeleteResult(r)) {
          console.log(line);
        }
      });
    },
  );

program
  .command("history <file> [directory]")
  .description("List a note's epoch timeline, newest first (one line per coordinated pull/push capture)")
  .option("--records", "flat per-record snapshot listing instead of the epoch timeline")
  .action(async (file: string, directory: string | undefined, opts: { records?: boolean }, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const result = await runHistory(targetDir, file, { records: opts.records === true });
    emitResult(context, result, printHistoryResult);
  });

program
  .command("diff <file> <ref> [directory]")
  .description("Diff two snapshots, or one snapshot against the current remote copy")
  .addHelpText(
    "after",
    '\n<ref> is a snapshot id (diffed against the current remote copy) or <from>..<to> (two snapshot ids) - ' +
      'ids come from "icloud-md history <file>".',
  )
  .action(async (file: string, refArg: string, directory: string | undefined, _opts: unknown, command: Command) => {
    const context = contextFor(command);
    const parts = refArg.split("..");
    let fromId: string;
    let toId: string | undefined;
    if (parts.length === 1 && parts[0]) {
      fromId = parts[0];
    } else if (parts.length === 2 && parts[0] && parts[1]) {
      [fromId, toId] = [parts[0], parts[1]];
    } else {
      command.error(
        `Invalid ref "${refArg}" - expected a snapshot id or <from>..<to>.`,
      );
      return;
    }
    const targetDir = await resolveTargetDir(directory);
    const result = await runDiff(targetDir, file, fromId, toId, makeStatusSink(context));
    emitResult(context, result, (r) => console.log(renderDiffResult(r)));
    if (result.hasDifferences) {
      process.exitCode = 3;
    }
  });

program
  .command("revert <file> <id> [directory]")
  .description(
    "Write a historical snapshot back to the server (a real remote write - without --yes, reports what would " +
      "happen)",
  )
  .option("--yes", "confirm the write")
  .action(async (file: string, id: string, directory: string | undefined, opts: { yes?: boolean }, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const result = await runRevert(targetDir, file, id, { confirmed: opts.yes === true, onLoginStatus: makeStatusSink(context) });
    emitResult(context, result, (r) => {
      for (const line of renderRevertResult(file, r)) {
        console.log(line);
      }
    });
  });

program
  .command("bug-report [directory]")
  .description(
    "Bundle version info, the last error, local state, and debug-log entries into a file to attach to a GitHub " +
      "issue - note titles, folder/sharer names, and the account's dsid/appleId are replaced with stable aliases",
  )
  .option("--since <duration>", 'how far back to bundle debug-log entries, e.g. "30m", "6h", "2d"')
  .option("--identify <file>", "print the alias a bug report would use for <file>, without writing a report")
  .action(
    async (
      directory: string | undefined,
      opts: { since?: string; identify?: string },
      command: Command,
    ) => {
      const context = contextFor(command);
      const targetDir = await resolveTargetDir(directory);

      if (opts.identify !== undefined && opts.since !== undefined) {
        command.error('"--since" and "--identify" can\'t be used together.');
        return;
      }

      if (opts.identify !== undefined) {
        const result = await runBugReportIdentify(targetDir, opts.identify);
        emitResult(context, result, (r) => console.log(`"${r.file}" is ${r.alias} in this vault's bug reports.`));
        return;
      }

      if (opts.since === undefined) {
        command.error('Either "--since <duration>" or "--identify <file>" is required.');
        return;
      }
      const since = parseSinceDuration(opts.since);
      if (!since) {
        command.error(`Invalid duration "${opts.since}" - expected a number followed by "m", "h", or "d" (e.g. 30m, 6h, 2d).`);
        return;
      }

      const result = await runBugReport(targetDir, since, { onDisclosure: (message) => console.error(message) });
      emitResult(context, result, (r) => {
        console.log(`Wrote ${r.outputPath}`);
        if (r.contentPreviewPath) {
          console.log(
            `Wrote a decoded-content preview to ${r.contentPreviewPath} - review it before sharing ${r.outputPath} ` +
              "anywhere. This preview file is not meant to be attached or shared; delete it once you're done.",
          );
        }
      });
    },
  );

program
  .command("reauthenticate [directory]")
  .description("Force a fresh sign-in for a directory's already-bound account (defaults to the current directory)")
  .action(async (directory: string | undefined, _opts: unknown, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const statusSink = makeStatusSink(context);
    statusSink("Opening a browser window for iCloud sign-in...");
    const result = await reauthenticateFolder(targetDir, { onStatus: statusSink });
    emitResult(context, { appleId: result.appleId, dsid: result.dsid, targetDir }, (r) =>
      console.log(`Reauthenticated as ${r.appleId} (dsid ${r.dsid}) for ${r.targetDir}.`),
    );
  });

program
  .command("verify-auth [directory]")
  .description("Check whether a directory's bound account is authenticated (defaults to the current directory)")
  .action(async (directory: string | undefined, _opts: unknown, command: Command) => {
    const context = contextFor(command);
    const targetDir = await resolveTargetDir(directory);
    const state = await readCloneState(targetDir);
    if (!state) {
      throw new NotClonedDirectoryError(targetDir);
    }
    const result = await resolveFolderAccount(targetDir, state.account, { onStatus: makeStatusSink(context) });
    emitResult(
      context,
      { appleId: result.appleId, fullName: result.fullName, dsid: result.dsid, ckdatabasewsUrl: result.ckdatabasewsUrl },
      (r) => {
        console.log(`Authenticated as ${r.appleId}${r.fullName ? ` (${r.fullName})` : ""}`);
        console.log(`dsid: ${r.dsid}`);
        console.log(`Notes CloudKit host: ${r.ckdatabasewsUrl ?? "(not reported)"}`);
      },
    );
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const context = createOutputContext(preParsedJson);
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        process.exitCode = 0;
        return;
      }
      process.exitCode = emitUsageError(context, error.message);
      return;
    }

    // Best-effort: a failure to persist this shouldn't mask the real error below.
    await recordLastError(error).catch(() => {});
    process.exitCode = emitError(context, error);
  }
}

await main();
