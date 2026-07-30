/**
 * Containment: the rules that keep a live test run from ever touching real
 * notes, and the teardown that removes what a run created.
 *
 * Two independent keys must both turn before anything is deleted:
 *
 *   1. the record lives inside the designated test folder, and
 *   2. its title carries an `(itest-<runId>)` prefix.
 *
 * Either alone is not enough. A prefix-only rule would let a typo'd folder
 * name delete something elsewhere in the account; a folder-only rule ("empty
 * the test folder") would delete anything a human happened to file there. The
 * suite also refuses to start if the folder holds anything unprefixed, on the
 * theory that an unexpected note there means the folder is not what we think
 * it is.
 *
 * The test folder itself is never created or deleted here - `push` cannot
 * create folders at all (see `push.ts`), which is a useful accident: the
 * suite is structurally incapable of inventing a folder outside the
 * sanctioned one. Create it once by hand, or with `integration/setupFolder.ts`.
 */

import { randomBytes } from "node:crypto";
import type { ObjectInfo } from "../src/commands/object.js";
import { runCli } from "./cli.js";

/** A per-run id: short, lowercase hex, stable for the life of one run. */
export function newRunId(): string {
  return randomBytes(3).toString("hex");
}

/**
 * Any run's fixture prefix - the discovery pattern used by the sweeper.
 *
 * Parentheses rather than the more obvious square brackets: in a
 * filename-as-title vault, `[` and `]` are homoglyph-substituted on the way
 * into a file name (they would otherwise break Obsidian wikilinks - see
 * `titleFilename.ts`). A fixture prefix must not collide with the projection
 * the suite exists to test, so it uses characters the projection leaves
 * alone. The homoglyph behaviour gets its own dedicated test instead.
 */
export const ANY_RUN_PREFIX = /^\(itest-[0-9a-f]{6}\)\s/;

/** This run's fixture prefix. */
export function runPrefix(runId: string): string {
  return `(itest-${runId}) `;
}

/** The title a fixture note carries, so both containment keys are visible in the UI. */
export function fixtureTitle(runId: string, name: string): string {
  return `${runPrefix(runId)}${name}`;
}

export class ContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainmentError";
  }
}

export interface FolderContents {
  folder: ObjectInfo;
  /** Live notes filed inside it. */
  notes: ObjectInfo[];
}

/** Every record in the account's zone, as the CLI's own plumbing sees it. */
async function listObjects(vaultDir: string): Promise<ObjectInfo[]> {
  const result = await runCli<ObjectInfo[]>(["object", "list", vaultDir]);
  if (!Array.isArray(result.json)) {
    throw new ContainmentError(`"object list" did not return a list (stdout: ${result.stdout.slice(0, 200)})`);
  }
  return result.json;
}

/**
 * Locates the test folder and the live notes inside it. Throws rather than
 * creating anything: a missing folder is a setup step for a human, never
 * something a test run improvises.
 */
export async function readTestFolder(vaultDir: string, folderName: string): Promise<FolderContents> {
  const objects = await listObjects(vaultDir);
  const folders = objects.filter((o) => o.recordType.includes("Folder") && o.state === "live" && o.title === folderName);

  if (folders.length === 0) {
    throw new ContainmentError(
      `No folder named "${folderName}" exists in this account. Create it (in Apple Notes, at icloud.com/notes, ` +
        `or with "npx tsx integration/setupFolder.ts") before running the integration suite - it is the container ` +
        `that keeps fixtures away from real notes.`,
    );
  }
  if (folders.length > 1) {
    throw new ContainmentError(
      `${folders.length} folders are named "${folderName}". Containment needs exactly one; remove the duplicates.`,
    );
  }

  const folder = folders[0]!;
  const notes = objects.filter(
    (o) => o.recordType.includes("Note") && o.state === "live" && o.references.includes(folder.recordName),
  );
  return { folder, notes };
}

/**
 * Pre-flight guard. Refuses to run if the test folder contains anything that
 * is not a fixture, and reports any leftovers from earlier runs so a crashed
 * run's debris is visible rather than silently inherited.
 */
export async function assertFolderSafe(vaultDir: string, folderName: string): Promise<FolderContents> {
  const contents = await readTestFolder(vaultDir, folderName);

  const foreign = contents.notes.filter((note) => !ANY_RUN_PREFIX.test(note.title ?? ""));
  if (foreign.length > 0) {
    const listing = foreign.map((n) => `  - ${JSON.stringify(n.title ?? "(untitled)")} (${n.recordName})`).join("\n");
    throw new ContainmentError(
      `The folder "${folderName}" contains ${foreign.length} note(s) that this suite did not create:\n${listing}\n` +
        `The suite will not run against a folder holding real notes. Move them elsewhere, or point ` +
        `ICLOUD_MD_ITEST_FOLDER at a dedicated folder.`,
    );
  }

  return contents;
}

export interface TeardownReport {
  deleted: { recordName: string; title: string }[];
  failed: { recordName: string; title: string; error: string }[];
  /** Fixtures from *other* runs that were left in place. */
  skippedOtherRuns: { recordName: string; title: string }[];
}

/**
 * Deletes this run's fixtures, and only those. `object delete` performs
 * Apple's own two-stage purge, so attachment-bearing and unparseable notes go
 * too - which matters, because a test that produced a broken note is exactly
 * the one whose debris must not survive.
 *
 * A record qualifies if it is in the test folder *and* either:
 *
 *   - it appeared during the run (it is not in `baseline`, the set of records
 *     present when the run started), or
 *   - its title carries this run's prefix.
 *
 * The first clause exists because a title is not a reliable handle for
 * something a *failing* test produced: a note created with no title at all
 * matches no prefix, so a title-only rule strands it in the folder, where it
 * then trips the pre-flight guard and blocks every later run. Membership of
 * the folder still bounds everything, and the guard has already established
 * that the folder held nothing foreign when the run began.
 *
 * Never passes `--yes`, so a Folder can never be deleted through this path
 * even if one somehow matched.
 */
export async function teardownRun(
  vaultDir: string,
  folderName: string,
  runId: string,
  baseline: ReadonlySet<string>,
): Promise<TeardownReport> {
  return teardownMatching(
    vaultDir,
    folderName,
    (note) => !baseline.has(note.recordName) || (note.title ?? "").startsWith(runPrefix(runId)),
  );
}

/**
 * Deletes fixtures from *every* run - the cleanup for debris a crashed run
 * left behind, including untitled notes a failed test produced. Bounded by
 * folder membership; run it deliberately, not as part of a test.
 */
export async function sweepAllRuns(vaultDir: string, folderName: string): Promise<TeardownReport> {
  return teardownMatching(vaultDir, folderName, () => true);
}

async function teardownMatching(
  vaultDir: string,
  folderName: string,
  matches: (note: ObjectInfo) => boolean,
): Promise<TeardownReport> {
  const contents = await readTestFolder(vaultDir, folderName);
  const report: TeardownReport = { deleted: [], failed: [], skippedOtherRuns: [] };

  for (const note of contents.notes) {
    const title = note.title ?? "";
    // Key 1 (folder membership) is established by readTestFolder; key 2 is
    // the caller's predicate.
    if (!matches(note)) {
      report.skippedOtherRuns.push({ recordName: note.recordName, title });
      continue;
    }

    try {
      await runCli(["object", "delete", note.recordName, vaultDir]);
      report.deleted.push({ recordName: note.recordName, title });
    } catch (error) {
      report.failed.push({ recordName: note.recordName, title, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return report;
}
