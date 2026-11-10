import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const scratchDir = await mkdtemp(path.join(os.tmpdir(), "pull-drawing-name-"));
const mockedHomedir = mock.method(os, "homedir", () => scratchDir);
const { create } = await import("@bufbuild/protobuf");
const { AttachmentInfoSchema } = await import("../notes/gen/topotext_pb.js");
const { buildInitialNoteDocument, encodeNoteDocument } = await import("../notes/noteDocument.js");
const { compressNoteDocument } = await import("../notes/noteText.js");
const { classifyNoteRecord } = await import("../notes/decodeNoteRecord.js");
const { formatEmbedMarker } = await import("../notes/unknownContent.js");
const { readCloneState, writeCloneState } = await import("../notes/cloneState.js");
const { writeBaseCopy } = await import("../notes/baseCopy.js");
const { composeNoteFile } = await import("../notes/noteIdFrontmatter.js");
const { writeSessionFile } = await import("../session.js");
const { accountSessionPath } = await import("../auth/accountStore.js");
const { runPull } = await import("./pull.js");
mockedHomedir.mock.restore();
after(() => rm(scratchDir, { recursive: true, force: true }));
const noteId = "11111111-1111-4111-8111-111111111111";
const account = { appleId: "fixture@example.invalid", dsid: "offline-pull-drawing" };
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
