import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

// Sessions and every HTTP request are isolated from the real account.
const scratchDir = await mkdtemp(path.join(os.tmpdir(), "drawing-title-sync-"));
const mockedHomedir = mock.method(os, "homedir", () => scratchDir);
const { create } = await import("@bufbuild/protobuf");
const { AttachmentInfoSchema } = await import("../notes/gen/topotext_pb.js");
const { buildInitialNoteDocument, encodeNoteDocument } = await import("../notes/noteDocument.js");
const { compressNoteDocument } = await import("../notes/noteText.js");
const { classifyNoteRecord } = await import("../notes/decodeNoteRecord.js");
const { formatEmbedMarker } = await import("../notes/unknownContent.js");
const { writeCloneState, readCloneState } = await import("../notes/cloneState.js");
const { writeBaseCopy, readBaseCopy } = await import("../notes/baseCopy.js");
const { composeNoteFile } = await import("../notes/noteIdFrontmatter.js");
const { writeSessionFile } = await import("../session.js");
const { accountSessionPath } = await import("../auth/accountStore.js");
const { runPush, buildPushPlan } = await import("./push.js");
const { runPull } = await import("./pull.js");
mockedHomedir.mock.restore();
after(() => rm(scratchDir, { recursive: true, force: true }));
const noteId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";
const account = { appleId: "fixture@example.invalid", dsid: "offline-drawing" };

async function fixture(run: (f: {
  vault: string; file: string; records: Map<string, CloudKitRecord>;
  writes: Array<{ operations: Array<{ record: CloudKitRecord }>; options: RequestInit }>;
  reply: { mode: string };
}) => Promise<void>) {
  const vault = await mkdtemp(path.join(scratchDir, "vault-"));
  const replica = new Uint8Array(16).fill(7);
  const doc = buildInitialNoteDocument("\uFFFC", replica);
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { attachmentIdentifier: attachmentId, typeUTI: "com.apple.paper" });
  const records = new Map<string, CloudKitRecord>([
    [noteId, { recordName: noteId, recordType: "Note", recordChangeTag: "note-tag", parentRecordName: folderId, fields: {
      Deleted: { type: "INT64", value: 0 }, Folder: { type: "REFERENCE", value: { recordName: folderId } },
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("Old").toString("base64") },
      TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64") },
    } }],
    [attachmentId, { recordName: attachmentId, recordType: "Attachment", recordChangeTag: "drawing-tag", parentRecordName: noteId, fields: {
      Deleted: { type: "INT64", value: 0 }, Note: { type: "REFERENCE", value: { recordName: noteId } },
      UTI: { type: "STRING", value: "com.apple.paper" }, PaperDatabase: { type: "ASSETID", value: { fileChecksum: "unchanged" } },
    } }],
    [folderId, { recordName: folderId, recordType: "Folder", recordChangeTag: "folder-tag", fields: {
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("TEST").toString("base64") }, Deleted: { type: "INT64", value: 0 },
    } }],
  ]);
  const decoded = classifyNoteRecord(records.get(noteId)!, { titleMode: "filename" });
  assert.equal(decoded.status, "ok");
  if (decoded.status !== "ok") return;
  const body = decoded.markdownText.replace("\uFFFC", formatEmbedMarker(decoded.attachments[0]!));
  await writeCloneState(vault, { account, titleMode: "filename", replicaId: Buffer.from(replica).toString("base64"), syncToken: "token",
    folders: { [folderId]: { name: "TEST", dirName: "TEST" } },
    notes: { [noteId]: { file: "TEST/Old.md", recordChangeTag: "note-tag", modificationDate: 100, folderRecordName: folderId } },
  });
  await mkdir(path.join(vault, "TEST"));
  await writeBaseCopy(vault, noteId, body);
  const file = path.join(vault, "TEST/New.md");
  await writeFile(file, composeNoteFile("", body, noteId));
  await writeSessionFile({ cookie: "fixture=local", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1", capturedAt: new Date().toISOString() }, accountSessionPath(account.dsid));
  const writes: Array<{ operations: Array<{ record: CloudKitRecord }>; options: RequestInit }> = [];
  const reply = { mode: "success" };
  const originalFetch = globalThis.fetch;
  const wire = (record: CloudKitRecord) => ({ ...record,
    ...(record.parentRecordName ? { parent: { recordName: record.parentRecordName } } : {}),
    ...(record.shareRecordName ? { share: { recordName: record.shareRecordName } } : {}),
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/validate")) return Response.json({ dsInfo: account, webservices: { ckdatabasews: { url: "https://cloudkit.invalid" } } });
    const request = JSON.parse(init!.body as string);
    if (url.pathname.endsWith("/records/lookup")) return Response.json({ records: request.records.map(({ recordName }: { recordName: string }) => {
      assert.ok(records.has(recordName), "unexpected offline lookup");
      return wire(records.get(recordName)!);
    }) });
    assert.ok(url.pathname.endsWith("/records/modify"), "unexpected offline request");
    writes.push({ operations: request.operations, options: init! });
    if (reply.mode === "lost") throw Error("offline lost response");
    const saved = request.operations.map(({ record }: { record: CloudKitRecord }) => {
      const old = records.get(record.recordName)!;
      const fields = Object.fromEntries(Object.entries(record.fields).map(([key, field]) => [key,
        { ...field, type: key === "ModificationDate" ? "TIMESTAMP" : "ENCRYPTED_BYTES" },
      ]));
      const updated = { ...old, recordChangeTag: old.recordChangeTag + "-new", fields: { ...old.fields, ...fields } };
      records.set(record.recordName, updated);
      return wire(updated);
    });
    return Response.json({ records: reply.mode === "missing" ? saved.slice(0, 1) : saved.reverse() });
  };
  try { await run({ vault, file, records, writes, reply }); }
  finally { globalThis.fetch = originalFetch; await rm(vault, { recursive: true, force: true }); }
}

test("drawing filename rename sends one metadata pair and settles tracking without changing body", () => fixture(async f => {
  const before = await readFile(f.file);
  const base = await readBaseCopy(f.vault, noteId);
  const result = await runPush(f.vault);
  assert.equal(result.pushed, 1);
  assert.equal(f.writes.length, 1);
  const operations = f.writes[0]!.operations;
  assert.deepEqual(operations.map(o => Object.keys(o.record.fields).sort()), [["ModificationDate", "TitleEncrypted"], ["UserTitle"]]);
  assert.deepEqual(operations.map(o => o.record.recordChangeTag), ["note-tag", "drawing-tag"]);
  assert.equal(f.writes[0]!.options.redirect, "error");
  assert.ok(f.writes[0]!.options.signal instanceof AbortSignal);
  const entry = (await readCloneState(f.vault))!.notes[noteId]!;
  assert.equal(entry.file, "TEST/New.md");
  assert.equal(entry.recordChangeTag, "note-tag-new");
  assert.deepEqual(await readFile(f.file), before);
  assert.equal(await readBaseCopy(f.vault, noteId), base);
  assert.equal((await runPush(f.vault)).entries.length, 0);
  assert.equal(f.writes.length, 1);
}));

test("drawing rename dry run leaves tracking and cloud untouched", () => fixture(async f => {
  const result = await runPush(f.vault, { dryRun: true });
  assert.equal(result.entries[0]?.resolution, "ready");
  assert.equal(f.writes.length, 0);
  assert.equal((await readCloneState(f.vault))!.notes[noteId]!.file, "TEST/Old.md");
}));
for (const mode of ["missing", "lost"]) test(`drawing rename ${mode} reply stays unsettled without retry`, () => fixture(async f => {
  f.reply.mode = mode;
  const result = await runPush(f.vault);
  assert.equal(result.pushed, 0);
  assert.equal(f.writes.length, 1);
  assert.equal((await readCloneState(f.vault))!.notes[noteId]!.file, "TEST/Old.md");
}));
test("drawing rename refuses a local snapshot changed after planning", () => fixture(async f => {
  const plan = await buildPushPlan(f.vault);
  assert.equal(plan.entries[0]?.resolution, "ready");
  await writeFile(f.file, (await readFile(f.file, "utf8")) + "\nEdited");
  assert.equal((await plan.entries[0]!.execute!()).succeeded, false);
  assert.equal(f.writes.length, 0);
  assert.equal(plan.state.notes[noteId]!.file, "TEST/Old.md");
}));
test("drawing rename refuses a shared ancestor folder", () => fixture(async f => {
  f.records.get(folderId)!.shareRecordName = "shared-folder";
  const result = await runPush(f.vault);
  assert.equal(result.entries[0]?.resolution, "refused");
  assert.equal(f.writes.length, 0);
}));

for (const scenario of ["unchanged", "recorded-title", "changed-tag", "pending", "already-pushed", "new-note"] as const) {
  test(`pull drawing title naming: ${scenario}`, async () => {
    const vault = await mkdtemp(path.join(scratchDir, "vault-"));
    const replica = new Uint8Array(16).fill(7);
    const doc = buildInitialNoteDocument("\uFFFC", replica);
    doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { attachmentIdentifier: "DRAWING", typeUTI: "com.apple.paper" });
    const record = { recordName: noteId, recordType: "Note", recordChangeTag: scenario === "changed-tag" ? "new-tag" : "same-tag", fields: {
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("Cloud drawing").toString("base64") },
      TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64") },
      Folder: { type: "REFERENCE", value: { recordName: "FOLDER" } },
    } };
    const decoded = classifyNoteRecord(record, { titleMode: "filename" });
    assert.equal(decoded.status, "ok");
    if (decoded.status !== "ok") return;
    const body = decoded.markdownText.replace("\uFFFC", formatEmbedMarker(decoded.attachments[0]!));
    const oldFile = scenario === "already-pushed" ? "TEST/Cloud drawing.md" : "TEST/\uFFFC.md";
    const recordedTitle = scenario === "recorded-title" ? "Legacy title" : undefined;
    const contents = composeNoteFile("", body, noteId, recordedTitle);
    await mkdir(path.join(vault, "TEST"));
    if (scenario !== "new-note") {
      await writeFile(path.join(vault, oldFile), contents);
      await writeBaseCopy(vault, noteId, body);
    }
    await writeCloneState(vault, { account, titleMode: "filename", syncToken: undefined, replicaId: Buffer.from(replica).toString("base64"),
      folders: { FOLDER: { name: "TEST", dirName: "TEST" } },
      notes: scenario === "new-note" ? {} : { [noteId]: {
        file: oldFile, recordChangeTag: "same-tag", modificationDate: 100, folderRecordName: "FOLDER", frontmatterTitle: recordedTitle,
        ...(scenario === "pending" ? { pendingRename: "Earlier pending.md" } : {}),
      } },
    });
    await writeSessionFile({ cookie: "fixture=local", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1", capturedAt: new Date().toISOString() }, accountSessionPath(account.dsid));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/validate")) return Response.json({ dsInfo: account, webservices: { ckdatabasews: { url: "https://cloudkit.invalid" } } });
      if (url.pathname.endsWith("/changes/database")) return Response.json({ zones: [] });
      if (url.pathname.endsWith("/changes/zone")) return Response.json({ zones: [{ zoneID: { zoneName: "Notes" }, syncToken: "next-token", records: [
        { recordName: "FOLDER", recordType: "Folder", fields: { TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("TEST").toString("base64") } } }, record,
      ] }] });
      if (url.pathname.endsWith("/records/lookup")) {
        const requested = JSON.parse(init!.body as string).records;
        return Response.json({ records: requested.map(({ recordName }: { recordName: string }) => {
          assert.equal(recordName, "DRAWING");
          return { recordName, recordType: "Attachment", fields: { UTI: { type: "STRING", value: "com.apple.paper" } } };
        }) });
      }
      assert.fail("Unexpected offline request: " + url.pathname);
    };
    try {
      await runPull(vault, undefined, undefined, { deferRenames: scenario === "pending" });
      const entry = (await readCloneState(vault))!.notes[noteId]!;
      const expected = scenario === "changed-tag" || scenario === "new-note" ? "TEST/Cloud drawing.md" : oldFile;
      assert.equal(entry.file, expected);
      assert.equal(entry.frontmatterTitle, recordedTitle);
      assert.equal(entry.pendingRename, scenario === "pending" ? "Cloud drawing.md" : undefined);
      if (scenario === "unchanged" || scenario === "recorded-title" || scenario === "already-pushed") {
        assert.equal(await readFile(path.join(vault, expected), "utf8"), contents);
      }
    } finally {
      globalThis.fetch = originalFetch;
      await rm(vault, { recursive: true, force: true });
    }
  });
}
