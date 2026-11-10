import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RecordUpdate } from "./databaseClient.js";

// Keep the real loggedFetch path, but isolate its debug log from user data.
const scratch = await mkdtemp(path.join(os.tmpdir(), "icloud-md-write-policy-"));
const home = mock.method(os, "homedir", () => scratch);
const { updateRecords } = await import("./databaseClient.js");
home.mock.restore();
after(() => rm(scratch, { recursive: true, force: true }));

const session = { cookie: "test-cookie", clientId: "test-client", clientBuildNumber: "test-build", clientMasteringNumber: "test-mastering", capturedAt: "2026-11-10T00:00:00Z" };
const updates: RecordUpdate[] = [
  { recordName: "note", recordType: "Note", recordChangeTag: "note-before", parentRecordName: "folder", fields: { TitleEncrypted: { value: "TmV3" } } },
  { recordName: "drawing", recordType: "Attachment", recordChangeTag: "drawing-before", parentRecordName: "note", fields: { UserTitle: { value: "TmV3" } } },
];
const zone = { zoneName: "Notes" };

for (const controlled of [false, true]) {
  test(`updateRecords ${controlled ? "forwards caller transport controls" : "preserves default fetch controls"} without changing the wire body`, async t => {
    const controller = new AbortController();
    const calls: RequestInit[] = [];
    t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.ok(init);
      calls.push(init);
      return new Response(JSON.stringify({ records: updates.map(update => ({ ...update, fields: {}, recordChangeTag: "after" })) }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    const options = controlled ? { redirect: "error" as const, signal: controller.signal } : undefined;
    const result = await updateRecords(session, "https://ckdatabasews.example", "12345", "private", zone, updates, options);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.redirect, controlled ? "error" : undefined);
    assert.equal(calls[0]!.signal, controlled ? controller.signal : undefined);
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), {
      operations: updates.map(({ parentRecordName, ...record }) => ({ operationType: "update", record: { ...record, parent: { recordName: parentRecordName } } })),
      zoneID: zone,
    });
    assert.deepEqual(result.map(record => record.ok && record.record.recordName), ["note", "drawing"]);
  });
}

test("updateRecords propagates a transport failure without retrying the write", async t => {
  const failure = new Error("ambiguous transport failure");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw failure;
  });
  await assert.rejects(
    updateRecords(session, "https://ckdatabasews.example", "12345", "private", zone, updates, { redirect: "error", signal: new AbortController().signal }),
    error => error === failure,
  );
  assert.equal(calls, 1);
});
