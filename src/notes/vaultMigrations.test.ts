import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CURRENT_LAYOUT_VERSION,
  STATE_DIR_NAME,
  STATE_FILE_NAME,
  writeCloneState,
  type RawStateFile,
} from "./cloneState.js";
import { openVault, runVaultMigrations, type VaultMigration } from "./vaultMigrations.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-migrations-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes a state file at an arbitrary layoutVersion, which `writeCloneState`
 * deliberately won't do (it always stamps the current one). */
async function writeStateAtVersion(dir: string, state: RawStateFile): Promise<void> {
  await mkdir(path.join(dir, STATE_DIR_NAME), { recursive: true });
  await writeFile(path.join(dir, STATE_DIR_NAME, STATE_FILE_NAME), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

async function readStateFile(dir: string): Promise<RawStateFile> {
  const raw = await readFile(path.join(dir, STATE_DIR_NAME, STATE_FILE_NAME), "utf-8");
  return JSON.parse(raw) as RawStateFile;
}

test("openVault returns undefined for a directory that isn't a clone", () =>
  withTempDir(async (dir) => {
    assert.equal(await openVault(dir), undefined);
  }));

test("openVault reads a current-version vault unchanged", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, { syncToken: "token", notes: {} });

    const state = await openVault(dir);

    assert.equal(state?.layoutVersion, CURRENT_LAYOUT_VERSION);
    assert.equal(state?.syncToken, "token");
  }));

test("openVault refuses a layout-version-1 vault rather than migrating it", () =>
  withTempDir(async (dir) => {
    await writeStateAtVersion(dir, { syncToken: "token", notes: {} });

    await assert.rejects(() => openVault(dir), /old flat layout/);
  }));

test("openVault refuses a vault from a newer tool without touching it", () =>
  withTempDir(async (dir) => {
    const future = { layoutVersion: CURRENT_LAYOUT_VERSION + 1, syncToken: "token", notes: {} };
    await writeStateAtVersion(dir, future);

    await assert.rejects(() => openVault(dir), /newer version of icloud-md/);
    assert.deepEqual(await readStateFile(dir), future);
  }));

test("writeCloneState stamps the generator so a vault records its engine", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, { syncToken: "token", notes: {} });

    const state = await openVault(dir);

    assert.match(state?.generator ?? "", /^icloud-md \d+\.\d+\.\d+/);
  }));

// --- the migration chain itself ------------------------------------------
//
// The runner is exercised through `runVaultMigrations` against synthetic
// chains, so these cover multi-step behaviour the real (currently one-step)
// chain can't reach on its own. The real chain is covered further down.

function openWithMigrations(
  dir: string,
  migrations: readonly VaultMigration[],
  targetVersion: number,
  onMigration?: (migration: VaultMigration) => void,
): Promise<boolean> {
  return runVaultMigrations(dir, { migrations, targetVersion }, onMigration);
}

test("openVault runs each migration in order and commits the version after each", () =>
  withTempDir(async (dir) => {
    await writeStateAtVersion(dir, { layoutVersion: 2, syncToken: "token", notes: {} });
    const seen: number[] = [];
    const migrations: VaultMigration[] = [
      {
        from: 2,
        to: 3,
        describe: "second",
        run: async ({ state }) => {
          seen.push(2);
          return { ...state, addedByTwo: true };
        },
      },
      {
        from: 3,
        to: 4,
        describe: "third",
        run: async ({ state }) => {
          // Proves the previous step's output is what this one receives, and
          // that its version bump was committed before this ran.
          assert.equal(state.addedByTwo, true);
          assert.equal(state.layoutVersion, 3);
          seen.push(3);
          return { ...state, addedByThree: true };
        },
      },
    ];

    await openWithMigrations(dir, migrations, 4);

    assert.deepEqual(seen, [2, 3]);
    const state = await readStateFile(dir);
    assert.equal(state.layoutVersion, 4);
    assert.equal(state.addedByTwo, true);
    assert.equal(state.addedByThree, true);
  }));

test("openVault reports each migration it runs", () =>
  withTempDir(async (dir) => {
    await writeStateAtVersion(dir, { layoutVersion: 2, syncToken: "token", notes: {} });
    const described: string[] = [];
    const migrations: VaultMigration[] = [
      { from: 2, to: 3, describe: "recording note ids", run: async ({ state }) => state },
    ];

    await openWithMigrations(dir, migrations, 3, (migration) => described.push(migration.describe));

    assert.deepEqual(described, ["recording note ids"]);
  }));

test("a crash mid-chain leaves the vault at the last committed version, and replays from there", () =>
  withTempDir(async (dir) => {
    await writeStateAtVersion(dir, { layoutVersion: 2, syncToken: "token", notes: {} });
    let attempts = 0;
    const migrations: VaultMigration[] = [
      { from: 2, to: 3, describe: "first", run: async ({ state }) => ({ ...state, first: true }) },
      {
        from: 3,
        to: 4,
        describe: "second",
        run: async ({ state }) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("interrupted");
          }
          return { ...state, second: true };
        },
      },
    ];

    await assert.rejects(() => openWithMigrations(dir, migrations, 4), /interrupted/);

    // The first migration's bump was committed; the failed one's was not.
    const afterCrash = await readStateFile(dir);
    assert.equal(afterCrash.layoutVersion, 3);
    assert.equal(afterCrash.first, true);
    assert.equal(afterCrash.second, undefined);

    // Re-running resumes at 3 rather than replaying the first migration.
    await openWithMigrations(dir, migrations, 4);
    const afterRetry = await readStateFile(dir);
    assert.equal(afterRetry.layoutVersion, 4);
    assert.equal(afterRetry.second, true);
    assert.equal(attempts, 2);
  }));

test("a gap in the migration chain fails loudly instead of half-migrating", () =>
  withTempDir(async (dir) => {
    await writeStateAtVersion(dir, { layoutVersion: 2, syncToken: "token", notes: {} });
    const migrations: VaultMigration[] = [
      { from: 3, to: 4, describe: "unreachable", run: async ({ state }) => state },
    ];

    await assert.rejects(() => openWithMigrations(dir, migrations, 4), /bug in icloud-md/);
    assert.equal((await readStateFile(dir)).layoutVersion, 2);
  }));

// --- the real chain -------------------------------------------------------

test("a version-2 vault migrates forward on first contact, in place", () =>
  withTempDir(async (dir) => {
    await writeStateAtVersion(dir, {
      layoutVersion: 2,
      syncToken: "token",
      notes: { "REC-1": { file: "Notes/A.md", recordChangeTag: "t", modificationDate: 1 } },
    });
    const described: string[] = [];

    const state = await openVault(dir, { onMigration: (migration) => described.push(migration.describe) });

    assert.equal(state?.layoutVersion, CURRENT_LAYOUT_VERSION);
    // A pre-mode vault is in-body by definition, and nothing about its files
    // needs rewriting to say so.
    assert.equal(state?.titleMode, "in-body");
    assert.equal(state?.idInFrontmatter, false);
    assert.equal(state?.notes["REC-1"]?.file, "Notes/A.md", "the vault's contents come through untouched");
    assert.deepEqual(described, ["recording where this vault keeps note titles"]);

    // Committed to disk, not just to the returned object.
    assert.equal((await readStateFile(dir)).layoutVersion, CURRENT_LAYOUT_VERSION);
  }));

test("migrating twice is a no-op the second time", () =>
  withTempDir(async (dir) => {
    await writeStateAtVersion(dir, { layoutVersion: 2, syncToken: "token", notes: {} });

    await openVault(dir);
    const described: string[] = [];
    await openVault(dir, { onMigration: (migration) => described.push(migration.describe) });

    assert.deepEqual(described, [], "an already-current vault runs no migrations");
  }));

test("a filename-as-title vault keeps its mode through migration", () =>
  withTempDir(async (dir) => {
    // Shouldn't arise in practice (the mode postdates version 3), but the
    // migration must never clobber a mode it finds already set.
    await writeStateAtVersion(dir, {
      layoutVersion: 2,
      syncToken: "token",
      notes: {},
      titleMode: "filename",
      idInFrontmatter: true,
    });

    const state = await openVault(dir);

    assert.equal(state?.titleMode, "filename");
    assert.equal(state?.idInFrontmatter, true);
  }));
