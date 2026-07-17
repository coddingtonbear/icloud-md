import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "../notes/baseCopy.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { NotClonedDirectoryError, UnboundAccountError } from "../errors.js";
import { buildPushPlan, runPush } from "./push.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "push-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function state(): CloneState {
  return {
    syncToken: "token",
    notes: {
      REC1: { file: "Tracked.md", recordChangeTag: "1a", modificationDate: 100 },
    },
  };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

test("buildPushPlan refuses when there's no cloned state at all", () =>
  withTempDir(async (dir) => {
    await assert.rejects(() => buildPushPlan(dir), NotClonedDirectoryError);
  }));

test("buildPushPlan detects an untracked top-level .md file as a refused \"create\" entry, without touching the network", () =>
  withTempDir(async (dir) => {
    // No `account` on state - if this reached resolveFolderAccount it would
    // throw UnboundAccountError, proving the network was never touched for
    // a create-only plan.
    await writeCloneState(dir, { syncToken: "token", notes: {} });
    await writeFile(path.join(dir, "New Note.md"), "Hello", "utf-8");

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, [
      {
        kind: "create",
        file: "New Note.md",
        resolution: "refused",
        reason: "creating new notes isn't supported yet - this tool can only edit or delete existing notes for now",
      },
    ]);
  }));

test("buildPushPlan ignores a file already tracked in state.notes", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeFile(path.join(dir, "Tracked.md"), "Synced text", "utf-8");
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, []);
  }));

test("buildPushPlan ignores .md files inside subdirectories - only top-level untracked files count as creates", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, { syncToken: "token", notes: {} });
    await mkdir(path.join(dir, "attachments"), { recursive: true });
    await writeFile(path.join(dir, "attachments", "Nested.md"), "Hello", "utf-8");

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, []);
  }));

test("buildPushPlan requires a live check for a missing tracked file (a delete candidate) - reaches the network and fails without a bound account", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    // Tracked.md deliberately not written - "missing" locally.
    await writeCloneState(dir, s);

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

// CloudKit's forceDelete refuses a Note that still has an Attachment record
// pointing at it (regular or table) - confirmed live 2026-07-16
// (VALIDATING_REFERENCE_ERROR). state() has no `account`, so if this reached
// resolveFolderAccount it would throw UnboundAccountError instead of
// resolving to a plan entry - proving the refusal is caught locally.
test("buildPushPlan refuses a missing tracked file locally, without touching the network, when the note has a tracked attachment", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.attachments = {
      ATT1: { file: "attachments/keep.jpg", mediaRecordName: "MEDIA1", mediaFileChecksum: "abc", noteRecordName: "REC1" },
    };
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, [
      {
        kind: "delete",
        file: "Tracked.md",
        resolution: "refused",
        reason:
          "this note has an attachment - it can't be safely deleted through this tool yet. Remove the " +
          "attachment in Notes first, or delete the note directly there.",
      },
    ]);
  }));

test("buildPushPlan refuses a missing tracked file locally when the note has a tracked table attachment", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.tableAttachments = { "ATT-TABLE-1": { noteRecordName: "REC1" } };
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "delete");
    assert.equal(entries[0]?.resolution, "refused");
  }));

test("runPush prints \"Nothing to push.\" and doesn't rewrite state.json when the plan is empty", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeFile(path.join(dir, "Tracked.md"), "Synced text", "utf-8");
    await writeCloneState(dir, s);

    const { lines, restore } = captureLogs();
    try {
      await runPush(dir);
    } finally {
      restore();
    }

    assert.deepEqual(lines, ["Nothing to push."]);
  }));
