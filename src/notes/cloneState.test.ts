import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCloneState, writeCloneState, type CloneState } from "./cloneState.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "clonestate-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("round-trips shared-zone owners and per-zone syncTokens", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      syncToken: "private-token",
      sharedZoneSyncTokens: { _owner1: "shared-token-1" },
      notes: {
        "REC-PRIVATE": { file: "Own Note (REC).md", recordChangeTag: "a", modificationDate: 1 },
        "REC-SHARED": {
          file: "Cooking Recipes (REC).md",
          recordChangeTag: "b",
          modificationDate: 2,
          sharedZoneOwner: "_owner1",
        },
      },
    };

    await writeCloneState(dir, state);
    const readBack = await readCloneState(dir);

    assert.deepEqual(readBack?.sharedZoneSyncTokens, { _owner1: "shared-token-1" });
    assert.equal(readBack?.notes["REC-SHARED"]?.sharedZoneOwner, "_owner1");
    assert.equal(readBack?.notes["REC-PRIVATE"]?.sharedZoneOwner, undefined);
    assert.equal(readBack?.syncToken, "private-token");
  }));

test("round-trips unpublishableReason, absent means fully publishable", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      syncToken: "token",
      notes: {
        "REC-DEGRADED": {
          file: "Table Note (REC).md",
          recordChangeTag: "a",
          modificationDate: 1,
          unpublishableReason: "contains embedded content this tool can't parse (com.apple.notes.table)",
        },
        "REC-CLEAN": { file: "Plain Note (REC).md", recordChangeTag: "b", modificationDate: 2 },
      },
    };

    await writeCloneState(dir, state);
    const readBack = await readCloneState(dir);

    assert.equal(
      readBack?.notes["REC-DEGRADED"]?.unpublishableReason,
      "contains embedded content this tool can't parse (com.apple.notes.table)",
    );
    assert.equal(readBack?.notes["REC-CLEAN"]?.unpublishableReason, undefined);
  }));

test("reads a pre-shared-notes state file (no shared fields) without error", () =>
  withTempDir(async (dir) => {
    // Exactly what writeCloneState produced before shared-note support existed.
    const legacy: CloneState = {
      syncToken: "old-token",
      notes: {
        "REC-1": { file: "Note (REC1).md", recordChangeTag: "tag", modificationDate: 5 },
      },
    };
    await writeCloneState(dir, legacy);

    const readBack = await readCloneState(dir);
    assert.equal(readBack?.sharedZoneSyncTokens, undefined);
    assert.equal(readBack?.notes["REC-1"]?.sharedZoneOwner, undefined);
    assert.equal(readBack?.notes["REC-1"]?.file, "Note (REC1).md");
  }));
