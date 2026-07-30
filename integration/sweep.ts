/**
 * Cleanup for debris a crashed run left in the test folder.
 *
 * A run tears down after itself, but a run killed partway through (or one
 * whose teardown failed) can leave fixtures behind - and an unprefixed or
 * untitled leftover will block every later run at the containment guard.
 * This removes everything currently in the test folder.
 *
 *   ICLOUD_MD_ITEST=1 npx tsx integration/sweep.ts
 *
 * Still bounded by the folder: it can only ever delete notes filed inside the
 * configured test folder, and never the folder itself.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { readTestFolder, sweepAllRuns } from "./containment.js";
import { Vault } from "./vault.js";

const config = await loadConfig();
const workDir = path.join(config.workRoot, "sweep");
await rm(workDir, { recursive: true, force: true });

console.log(`Sweeping folder "${config.folder}" (dsid ${config.dsid})...`);
const vault = await Vault.clone(config, path.join(workDir, "vault"));

const before = await readTestFolder(vault.dir, config.folder);
if (before.notes.length === 0) {
  console.log("Nothing to sweep - the folder is already empty.");
} else {
  console.log(`Found ${before.notes.length} note(s):`);
  for (const note of before.notes) {
    console.log(`  - ${JSON.stringify(note.title ?? "(untitled)")} (${note.recordName})`);
  }

  const report = await sweepAllRuns(vault.dir, config.folder);
  console.log(`\nDeleted ${report.deleted.length}, failed ${report.failed.length}.`);
  for (const failure of report.failed) {
    console.log(`  FAILED ${failure.recordName}: ${failure.error}`);
  }
}

await rm(workDir, { recursive: true, force: true });
