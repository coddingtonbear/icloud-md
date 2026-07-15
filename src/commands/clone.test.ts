import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runClone } from "./clone.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "clone-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("clone refuses to run against an already-cloned folder, without attempting to authenticate", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      account: { appleId: "me@example.com", dsid: "1234" },
      syncToken: "token",
      notes: {},
    };
    await writeCloneState(dir, state);

    await assert.rejects(runClone(dir), /is already a cloned notes directory/);
  }));
