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

test("buildPushPlan treats an untracked top-level .md file as a real create candidate - it proceeds to the network", () =>
  withTempDir(async (dir) => {
    // No `account` on state - the UnboundAccountError proves the file passed
    // every local gate and the plan went on to need a session for the create.
    await writeCloneState(dir, { syncToken: "token", notes: {} });
    await writeFile(path.join(dir, "New Note.md"), "Hello", "utf-8");

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan refuses an empty untracked file locally, without touching the network", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, { syncToken: "token", notes: {} });
    await writeFile(path.join(dir, "Empty.md"), "", "utf-8");

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, [
      { kind: "create", file: "Empty.md", resolution: "refused", reason: "the file is empty - nothing to create" },
    ]);
  }));

test("buildPushPlan refuses an untracked file with conflict markers locally - same gate as a modified file", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, { syncToken: "token", notes: {} });
    await writeFile(path.join(dir, "Conflicted.md"), "a\n<<<<<<< local\nb\n=======\nc\n>>>>>>> remote\n", "utf-8");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "create");
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /conflict markers/);
  }));

test("buildPushPlan refuses an untracked file referencing attachments locally", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, { syncToken: "token", notes: {} });
    await writeFile(path.join(dir, "HasAttachment.md"), "Look:\n\n![pic](attachments/pic.jpg)\n", "utf-8");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /attachments/);
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

// Deletion is a trash-move update as of the 2026-07-16 HAR analysis, which
// works regardless of attachments - so an attachment-bearing delete
// candidate is no longer refused locally. state() has no `account`, so the
// UnboundAccountError proves the plan proceeds toward the network instead
// of resolving to a local refusal.
test("buildPushPlan no longer refuses deleting a note with a tracked attachment - it proceeds to the network", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.attachments = {
      ATT1: { file: "attachments/keep.jpg", mediaRecordName: "MEDIA1", mediaFileChecksum: "abc", noteRecordName: "REC1" },
    };
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeCloneState(dir, s);

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan no longer refuses deleting a note with a tracked table attachment - it proceeds to the network", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.tableAttachments = { "ATT-TABLE-1": { noteRecordName: "REC1" } };
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeCloneState(dir, s);

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
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
