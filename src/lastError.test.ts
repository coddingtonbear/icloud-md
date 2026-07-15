import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordLastError, readLastError } from "./lastError.js";
import { IcloudNotesSyncError, NotClonedDirectoryError } from "./errors.js";

async function withTempPath(run: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "lasterror-test-"));
  try {
    await run(path.join(dir, "nested", "last-error.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readLastError returns undefined when nothing has been recorded yet", () =>
  withTempPath(async (filePath) => {
    assert.equal(await readLastError(filePath), undefined);
  }));

test("records and reads back a plain Error's message with no hint", () =>
  withTempPath(async (filePath) => {
    await recordLastError(new Error("boom"), filePath);
    const record = await readLastError(filePath);
    assert.ok(record);
    assert.equal(record.message, "boom");
    assert.equal(record.hint, undefined);
    assert.ok(!Number.isNaN(Date.parse(record.timestamp)));
  }));

test("records an IcloudNotesSyncError's hint alongside its message", () =>
  withTempPath(async (filePath) => {
    const error = new NotClonedDirectoryError("/tmp/some-dir");
    await recordLastError(error, filePath);
    const record = await readLastError(filePath);
    assert.ok(record);
    assert.equal(record.message, error.message);
    assert.equal(record.hint, error.hint);
  }));

test("a later recordLastError call overwrites the previous record", () =>
  withTempPath(async (filePath) => {
    await recordLastError(new Error("first"), filePath);
    await recordLastError(new IcloudNotesSyncError("second", { hint: "do the thing" }), filePath);

    const record = await readLastError(filePath);
    assert.ok(record);
    assert.equal(record.message, "second");
    assert.equal(record.hint, "do the thing");
  }));

test("readLastError returns undefined for a truncated/corrupt file instead of throwing", () =>
  withTempPath(async (filePath) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"timestamp": "2026-07-14T00:00:00.000Z", "mess', "utf-8");

    assert.equal(await readLastError(filePath), undefined);
  }));

test("creates the parent directory if it doesn't exist yet", () =>
  withTempPath(async (filePath) => {
    await recordLastError(new Error("created"), filePath);
    const record = await readLastError(filePath);
    assert.equal(record?.message, "created");
  }));
