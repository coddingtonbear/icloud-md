/**
 * Forward-only vault migrations.
 *
 * The project supports exactly one on-disk paradigm at a time: rather than
 * teaching every command to read several vault generations, a vault is
 * migrated up to `CURRENT_LAYOUT_VERSION` the moment icloud-md touches it,
 * and command code only ever sees the current shape. `openVault` is the
 * entry point that guarantees that, and every command that reads note data
 * goes through it instead of `readCloneState`.
 *
 * Deliberately *not* covered: layout version 1 (the original flat layout,
 * pre-folder-support). Writing a real flat->tree migration for 0.1-era
 * vaults isn't worth the code; those keep the existing "re-clone into a
 * fresh directory" refusal, which is why migrations start at version 2.
 *
 * Auth-only and diagnostic readers (`reauthenticate`, `verify-auth`,
 * `bug-report`) stay on the raw reader on purpose - they touch `account` or
 * report a vault's condition, and neither should rewrite a vault as a side
 * effect of asking a question about it.
 *
 * ## Writing a migration
 *
 * A migration must be **idempotent and re-runnable**. The `layoutVersion`
 * bump is the commit point and is written *after* the migration's file work
 * completes, so an interrupted run simply replays from the same version on
 * the next command. That only stays safe if replaying is harmless, so a
 * migration that rewrites files has to tolerate finding some of them already
 * rewritten.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { setNoteId } from "./noteIdFrontmatter.js";
import {
  CURRENT_LAYOUT_VERSION,
  readCloneState,
  readRawStateFile,
  writeRawStateFile,
  type CloneState,
  type RawStateFile,
} from "./cloneState.js";
import { UnsupportedVaultLayoutError, VaultFromNewerToolError } from "../errors.js";

/** The oldest `layoutVersion` the migration chain starts from. Anything
 * below this (including a state file with no version at all) is refused
 * rather than migrated - see the module comment. */
export const OLDEST_MIGRATABLE_LAYOUT_VERSION = 2;

export interface VaultMigrationContext {
  targetDir: string;
  /** The state file as it currently sits on disk - shaped for `from`, not
   * for the current version, which is why it's raw rather than `CloneState`. */
  state: RawStateFile;
}

export interface VaultMigration {
  /** The `layoutVersion` this migration reads. */
  from: number;
  /** The `layoutVersion` it produces - always `from + 1`, so the chain has
   * no gaps and each step is separately resumable. */
  to: number;
  /** One line for the progress log, e.g. "recording note ids in frontmatter". */
  describe: string;
  /** Performs the on-disk work and returns the updated state. The runner
   * stamps `to` and writes it; a migration must not write the state file
   * itself. */
  run(context: VaultMigrationContext): Promise<RawStateFile>;
}

/**
 * Brings a version-2 vault up to the one shape every later read assumes:
 * `titleMode` recorded explicitly, and every tracked note's file carrying its
 * `apple-note-id`.
 *
 * A version-2 vault predates the title mode entirely, so it is in-body by
 * definition and nothing about its *content* changes. The id stamping is the
 * part that touches files, and it's what lets `push` have exactly one pairing
 * path rather than an id path plus a heuristic one forever.
 *
 * Idempotent, as every migration must be: `setNoteId` returns the envelope
 * untouched when the id is already right, so a re-run after an interrupted
 * pass rewrites nothing. A tracked file that isn't on disk is skipped rather
 * than created - `pull` recreates it, and stamping a file into existence here
 * would resurrect notes the user deleted.
 *
 * Adopting `filename` in an existing vault is a *mode change*, not a version
 * migration: two vaults at version 3 legitimately differ on it.
 */
const recordTitleModeAndIds: VaultMigration = {
  from: 2,
  to: 3,
  describe: "recording note ids in each file's frontmatter",
  run: async ({ targetDir, state }) => {
    const notes = isRecord(state.notes) ? state.notes : {};
    for (const [recordName, entry] of Object.entries(notes)) {
      const file = isRecord(entry) && typeof entry.file === "string" ? entry.file : undefined;
      if (file === undefined) {
        continue;
      }
      const filePath = path.join(targetDir, file);
      let existing: string;
      try {
        existing = await readFile(filePath, "utf-8");
      } catch (cause) {
        if (isEnoent(cause)) {
          continue;
        }
        throw cause;
      }
      const { frontmatter, body } = splitFrontmatter(existing);
      const stamped = joinFrontmatter(setNoteId(frontmatter, recordName), body);
      if (stamped !== existing) {
        await writeFile(filePath, stamped, "utf-8");
      }
    }
    return { ...state, titleMode: state.titleMode === "filename" ? "filename" : "in-body" };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The migration chain, ordered by `from`. */
export const VAULT_MIGRATIONS: readonly VaultMigration[] = [recordTitleModeAndIds];

/** A chain and the version it climbs to. Separated from the module-level
 * constants purely so the runner can be exercised against synthetic chains -
 * production only ever uses `DEFAULT_MIGRATION_PLAN`. */
export interface MigrationPlan {
  migrations: readonly VaultMigration[];
  targetVersion: number;
}

export const DEFAULT_MIGRATION_PLAN: MigrationPlan = {
  migrations: VAULT_MIGRATIONS,
  targetVersion: CURRENT_LAYOUT_VERSION,
};

export interface OpenVaultOptions {
  /** Called once per migration actually run, for progress reporting. */
  onMigration?: (migration: VaultMigration) => void;
}

/**
 * Brings a vault up to `plan.targetVersion`, running each step in order and
 * committing after each. Returns false when `targetDir` isn't a clone at all.
 *
 * Throws `VaultFromNewerToolError` when the vault is *newer* than this build
 * understands: migrating forward means an older binary can encounter a shape
 * it has never seen, and it must say so plainly rather than guess (or, worse,
 * repeat the v1 advice to re-clone, which would be destructive here).
 */
export async function runVaultMigrations(
  targetDir: string,
  plan: MigrationPlan = DEFAULT_MIGRATION_PLAN,
  onMigration?: (migration: VaultMigration) => void,
): Promise<boolean> {
  const raw = await readRawStateFile(targetDir);
  if (raw === undefined) {
    return false;
  }

  let version = typeof raw.layoutVersion === "number" ? raw.layoutVersion : 0;
  if (version < OLDEST_MIGRATABLE_LAYOUT_VERSION) {
    throw new UnsupportedVaultLayoutError(targetDir);
  }
  if (version > plan.targetVersion) {
    throw new VaultFromNewerToolError(targetDir, version, plan.targetVersion);
  }

  let state = raw;
  while (version < plan.targetVersion) {
    const migration = plan.migrations.find((candidate) => candidate.from === version);
    if (!migration) {
      // A gap in the chain is a programming error, not a user's problem -
      // but failing here beats leaving the vault half-migrated.
      throw new Error(
        `No vault migration registered from layout version ${version} to ${plan.targetVersion} - this is a bug in icloud-md.`,
      );
    }
    onMigration?.(migration);
    state = await migration.run({ targetDir, state });
    // The version bump is the commit point: the file work above is complete
    // and idempotent, so a crash before this line just replays the same step.
    state = { ...state, layoutVersion: migration.to };
    await writeRawStateFile(targetDir, state);
    version = migration.to;
  }

  return true;
}

/**
 * Reads a vault's state, migrating it forward first if it was written by an
 * older build. Returns undefined when `targetDir` isn't a clone at all,
 * matching `readCloneState` so callers keep their "not a cloned directory"
 * handling. This is what every command that reads note data should call.
 */
export async function openVault(targetDir: string, options: OpenVaultOptions = {}): Promise<CloneState | undefined> {
  const isClone = await runVaultMigrations(targetDir, DEFAULT_MIGRATION_PLAN, options.onMigration);
  if (!isClone) {
    return undefined;
  }
  return readCloneState(targetDir);
}
