import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTableMarkdown } from "./decodeTableRecord.js";

// Real `MergeableDataEncrypted` captured live from the Attachment record
// behind "Test Table Note (2)" (dev notes, 2026-07-14T10:46/14:09/14:32/14:41),
// at its very first save: a 2x2 grid, second row still empty (the row was
// created before its cells were typed into).
const TABLE_FIRST_REVISION =
  "eJzt1E9oFFccwPGZyWZ39iWNr5OahofQdgxJjHZdB5tDxUOTqKTEoJtNemghxHW0u2x2ZXdFI3opiBcPihRLyUULObVNm4stNFQwSslhD+k/Dy0UNNAiEimoB7H27SbVbLKhh1JP32GH3/x+7/d5895jd23D+fq2ZRvSUF/etoQtgvrZbDZUX+ptO6BabcNx3Vej/3KpoG06VtTUsUbHGh1rdbR1DOr4gqoXQgRKM+vMUq+nNtumarMtZ6P7WncsPnIg7Xdn00dHMz3JnJ8oJLOZPv9QIZ6NJQ+/X1A/mx+Y35tiwhQnRJ8TXPj2G/1RsjxhaeHl2G6WK6auWKoc2y3VJGw99kRf63Tf0+cOyzZLt/OS3p7cOhuev3dhr3F5z0yxMXq+S1dNR16fbL6/M198PD98LRG5dHXKaReOsKKlbQXU02Mq10K6FnxWW9ZZW6Uz9Kym6lPCtvQhBRxLmhWZVZHVVGSB//tE7vRfnPbnHtxtGZ+9NTbUsLB4Ilc2dY7sOntj/5mBybbQw9S2pX0Kvafwin3W61rdqhMpdYoqnfVrnEhtRRasyEIVma06vMV31On5Gla8I6xrLy57xz+9pa/muhW9eraoXNa7O9bjWG9F/+PZWioS2+IYVWZZw1Ss0amyxsaVa+x67mt07eRBP1NIFsbcpkSu2o/YDeT99CE3mMjFssfybnhwsLenN3PQP+6GE7nF3rxbl/DT6aWk4+VEdjQycuRI2o90x3rikf6B/qOjB/xclYGBQi6ZOdyxftVA6S3L+zPZgp+PLP3NrB7o7V5jAIFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAVApPnmycaYlt/u6jYzt+/OlU17vvePLED198dfOT7WO/zQ21npuO/uHJ65PN93fmi4/nh68lIpeuTnnSP9V2OvDhGxOfnpt69PFfG+Ke3Dobnr93Ya9xec9MsTF6vsuTEyd794nxz4Y7fy/KP9XufZ68sqlzZNfZG/vPDEy2hR6mtnnyvdZXZFPdo19v/mLEPo8PbvTknf6L0/7cg7st47O3xoYaFt7cIJRYtUrHsi19m38DuMWS1w==";

// Same Attachment record's final revision (recordChangeTag 27k), after cell
// edits + inserting a 4th column: a 5x4 grid, confirmed against the live
// table by direct visual inspection (dev notes, 2026-07-14T14:41).
const TABLE_FINAL_REVISION =
  "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";

test("decodeTableMarkdown renders a real captured 2x2 grid, one row still blank", () => {
  const markdown = decodeTableMarkdown(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  assert.equal(markdown, ["| A0 | B0 |", "| --- | --- |", "|  |  |"].join("\n"));
});

test("decodeTableMarkdown renders a real captured 5x4 grid, verified against the live table", () => {
  const markdown = decodeTableMarkdown(Buffer.from(TABLE_FINAL_REVISION, "base64"));
  assert.equal(
    markdown,
    [
      "| A0 | B0 | B0-new | C0 |",
      "| --- | --- | --- | --- |",
      "| A1 | B1 | B1-new | C1 |",
      "| A2 | B2 | B2-new | C2 |",
      "| A3 | B3 | B3-new | C3-edited |",
      "| A4 | B4 | B4-new | C4 |",
    ].join("\n"),
  );
});

test("decodeTableMarkdown throws on bytes that aren't a table document, refusing rather than guessing", () => {
  assert.throws(() => decodeTableMarkdown(Buffer.from("not a real table")));
});
