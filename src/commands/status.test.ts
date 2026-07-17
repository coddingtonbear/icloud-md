import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCloneState } from "../notes/cloneState.js";
import { NotClonedDirectoryError, UnboundAccountError } from "../errors.js";
import { runStatus } from "./status.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "status-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("runStatus refuses when there's no cloned state at all", () =>
  withTempDir(async (dir) => {
    await assert.rejects(() => runStatus(dir), NotClonedDirectoryError);
  }));

test("runStatus renders \"Nothing to push.\" for an already-clean, untracked-file-free directory - same wording push uses", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, { syncToken: "token", notes: {} });

    const { lines, restore } = captureLogs();
    try {
      await runStatus(dir);
    } finally {
      restore();
    }

    assert.deepEqual(lines, ["Nothing to push."]);
  }));

test("runStatus renders an untracked file's refusal exactly like push --dry-run would, without needing a bound account", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, { syncToken: "token", notes: {} });
    await writeFile(path.join(dir, "New Note.md"), "Hello", "utf-8");

    const { lines, restore } = captureLogs();
    try {
      await runStatus(dir);
    } finally {
      restore();
    }

    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", /New Note\.md/);
    assert.match(lines[1] ?? "", /creating new notes isn't supported yet/);
    assert.match(lines[2] ?? "", /0 to create, 0 changed, 0 to delete\./);
  }));

test("runStatus requires the same live check push does for a missing tracked file - reaches the network and fails without a bound account", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, {
      syncToken: "token",
      notes: { REC1: { file: "Tracked.md", recordChangeTag: "1a", modificationDate: 100 } },
    });

    await assert.rejects(() => runStatus(dir), UnboundAccountError);
  }));
