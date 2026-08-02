/**
 * One live run: a work directory, the clones inside it, the containment
 * guard, and teardown.
 *
 * A run is deliberately loud about what it is about to do - it prints the
 * account, folder and run id before touching anything, so a misconfigured
 * run is obvious in the output rather than discovered afterwards.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { appleIdForDsid, loadConfig, type ItestConfig } from "./config.js";
import { runCli } from "./cli.js";
import { assertFolderSafe, newRunId, runPrefix, teardownRun, type TeardownReport } from "./containment.js";
import { NotesWebOracle } from "./webOracle.js";
import { Vault, type VaultOptions } from "./vault.js";

export class RunContext {
  private oracleHandle: NotesWebOracle | undefined;
  private readonly vaults: Vault[] = [];
  private primaryVault: Vault | undefined;
  /** Records already in the test folder when this run began - never ours to delete. */
  private baseline: ReadonlySet<string> = new Set();
  /** Non-Note records this run created, to remove once teardown has taken the
   * notes; see `disposeAfterTeardown`. */
  private readonly extraRecords: string[] = [];

  private constructor(
    readonly config: ItestConfig,
    readonly runId: string,
    readonly workDir: string,
  ) {}

  /**
   * The run's default working copy, in the standard (in-body title) mode.
   * Cloning the account is slow, so the vault the containment guard used is
   * kept and reused rather than cloned again.
   */
  get primary(): Vault {
    if (this.primaryVault === undefined) {
      throw new Error("RunContext.begin() has not completed");
    }
    return this.primaryVault;
  }

  /**
   * Prepares a run: resolves config, clones a control vault, and refuses to
   * continue unless the test folder is present and holds nothing but fixtures.
   */
  static async begin(): Promise<RunContext> {
    const config = await loadConfig();
    const runId = newRunId();
    const workDir = path.join(config.workRoot, runId);
    const context = new RunContext(config, runId, workDir);

    const appleId = await appleIdForDsid(config.dsid);
    console.error(
      `\n=== live integration run ${runId} ===\n` +
        `  account : ${appleId ?? "(unknown)"} (dsid ${config.dsid})\n` +
        `  folder  : ${config.folder}\n` +
        `  work dir: ${workDir}\n`,
    );

    // The guard needs a clone to talk to the account through; that clone
    // becomes the run's primary working copy rather than being thrown away.
    context.primaryVault = await context.vault("primary");
    const contents = await assertFolderSafe(context.primaryVault.dir, config.folder);
    context.baseline = new Set([...contents.notes, ...contents.subfolders].map((record) => record.recordName));
    console.error(`  folder "${config.folder}" is clean (${contents.notes.length} note(s), ${contents.subfolders.length} subfolder(s) from earlier runs)\n`);

    return context;
  }

  /** Clones another working copy for this run. */
  async vault(name: string, options: VaultOptions = {}): Promise<Vault> {
    const vault = await Vault.clone(this.config, path.join(this.workDir, name), options);
    this.vaults.push(vault);
    return vault;
  }

  /** The web oracle, opened lazily and shared - browser startup is expensive. */
  async oracle(): Promise<NotesWebOracle> {
    if (this.oracleHandle === undefined) {
      this.oracleHandle = await NotesWebOracle.open({ dsid: this.config.dsid, headless: this.config.headless });
    }
    return this.oracleHandle;
  }

  /** This run's fixture title prefix (see `ANY_RUN_PREFIX` for why parentheses). */
  title(name: string): string {
    return runPrefix(this.runId) + name;
  }

  /**
   * Registers a non-Note record for removal at the end of the run.
   *
   * Containment's two-key rule is built on notes and folders, which is
   * everything a *push* can create. A test that reaches CloudKit directly can
   * create records outside that walk - the live table fixture's `Attachment`
   * record is the case in point - and those would otherwise accumulate in the
   * account, invisible to both the pre-flight guard and the sweeper.
   *
   * They go after the notes: `forceDelete` is refused while a live record
   * still references the target, and the note referencing this one is a
   * fixture teardown has just purged.
   */
  disposeAfterTeardown(recordName: string): void {
    this.extraRecords.push(recordName);
  }

  /**
   * Deletes this run's fixtures and disposes of local state. Reports rather
   * than throws on a failed delete: a teardown that aborts halfway leaves
   * more debris than one that carries on and says what it could not remove.
   */
  async end(): Promise<TeardownReport> {
    await this.oracleHandle?.close();
    this.oracleHandle = undefined;

    const vaultDir = this.vaults[0]?.dir;
    let report: TeardownReport = { deleted: [], failed: [], skippedOtherRuns: [] };
    if (vaultDir !== undefined) {
      report = await teardownRun(vaultDir, this.config.folder, this.runId, this.baseline);
      console.error(
        `\n=== teardown ${this.runId}: deleted ${report.deleted.length}, failed ${report.failed.length}, ` +
          `left ${report.skippedOtherRuns.length} from other runs ===`,
      );
      for (const failure of report.failed) {
        console.error(`  FAILED to delete ${failure.title} (${failure.recordName}): ${failure.error}`);
      }

      for (const recordName of this.extraRecords) {
        try {
          await runCli(["object", "delete", recordName, vaultDir]);
          report.deleted.push({ recordName, title: "(non-note record)" });
        } catch (error) {
          // Reported, not thrown, for the same reason `teardownRun` reports:
          // a teardown that aborts halfway leaves more debris than one that
          // carries on and says what it could not remove.
          const message = error instanceof Error ? error.message : String(error);
          report.failed.push({ recordName, title: "(non-note record)", error: message });
          console.error(`  FAILED to delete ${recordName}: ${message}`);
        }
      }
    }

    if (!this.config.keepArtifacts) {
      await rm(this.workDir, { recursive: true, force: true });
    } else {
      console.error(`  clones kept at ${this.workDir}`);
    }
    return report;
  }
}
