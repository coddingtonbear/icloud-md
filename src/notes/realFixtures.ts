/**
 * Real captured `TextDataEncrypted` payloads (base64 of the raw compressed
 * bytes, exactly as `TextDataEncrypted` field values arrive from CloudKit -
 * the same format `decodeTableRecord.test.ts`'s `TABLE_FIRST_REVISION`/
 * `TABLE_FINAL_REVISION` already use), closing the fixture gap noted in the
 * protobuf-library migration plan (Step 0): before this, no real capture
 * exercised the plain-text `Note`/`TextRun`/`AttributeRun`/replica-table shape
 * `noteDocument.ts` round-trips - only hand-built synthetic documents did.
 */

/**
 * Real `TextDataEncrypted` captured live from the private Notes zone, record
 * `03667d1d-eee8-4e98-82fb-8c5cd02fd9d1` (recordChangeTag `25q`, dev notes
 * 2026-07-15T07:19), titled "Test Note": plain text, no attribute-run
 * formatting beyond the single whole-note paragraph style. Round-trips
 * cleanly against the existing hand-rolled codec - the baseline case.
 */
export const REAL_PLAIN_NOTE =
  "eJzjYBA6wMTBIMAgtZNJyD0ktbhEwS+/JJUrJCOzWAGIEhVKQGJ5QDGF0uLUFIW0/CKwUGZeukJ+aYlCQmZyTn5pii5IRbFucWVecgKXlAAXC8hMoKlgWo" +
  "MRLMIIFOGWAtMaTFARcQEdqAgzVMRVgAMqwgIVCRZghIqwQkV8BdigImxSQmARZwEmiIgCowY7VIwbZhtQjAOqUwxuFqeUGBcH0HX/gYAf6FI4W0mGS4pL" +
  "YFegMuu3GeHWniE5925+eFEkxMQRAsSMWhwcXEIgX7EAWbZAFrMACwANjjft";

/**
 * Real `TextDataEncrypted` captured live from the private Notes zone, record
 * `d85be482-6cdd-42b1-9780-f683424e33cc` (recordChangeTag `27z`, dev notes
 * 2026-07-15T07:19), titled "Test Note" - updated live by Adam specifically
 * for this fixture: 58 `AttributeRun`s exercising `font_weight`/
 * `underlined`/`strikethrough`/`emphasis_style`/`attachment_info`, and 75
 * `TextRun`s across 6 replicas with 21 tombstoned - a genuinely
 * multiply-edited document, not just a multiply-formatted one.
 *
 * Does **not** round-trip against the current hand-rolled codec: one
 * `TextRun` encodes its `sequence` field (this project's own field 5, not
 * part of the cross-checked Apple schema) twice in the same message
 * (`... 28 0e ... 28 10`, i.e. two different sequence values). `parseRun`
 * treats `sequence` as a plain optional scalar and silently keeps only the
 * last occurrence - see dev notes, 2026-07-15T07:27. This is exactly the
 * kind of gap Step 0 exists to surface: the migration's `.proto` must
 * declare `TextRun.sequence` as `repeated int32`, not `optional int32`, for
 * protobuf-es to preserve every occurrence.
 */
export const REAL_FORMATTED_MULTI_EDIT_NOTE =
  "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";

/**
 * Real `TextDataEncrypted` captured live from the private Notes zone, record
 * `72BE6881-7A65-4DF4-B1CC-D3F5033743BD` (recordChangeTag `j2`, dev notes
 * 2026-07-15T07:19, originally authored 2019-09-22), titled "this is a test
 * note. how well does this work when compared to the...": plain text with
 * non-ASCII (Spanish + an emoji), exercising UTF-8/UTF-16 boundary handling.
 * Round-trips cleanly against the existing hand-rolled codec.
 */
export const REAL_UNICODE_NOTE =
  "H4sIAAAAAAAAE+NgENrDxMEgwCC1lUkolaskI7NYAYgSFUpSi0sU8vJLUvUUFDLyyxXKU3NyFFLyU4sVwGrK84uyFcozUvMUkvNzCxKLUlMUSvKBUqkK6f" +
  "n56TmpCmWpRcWZ+Xn2XFxJpal5+cUKKYfXJhZ/mL90lpQAFwvIRqCdYFqDESzCCBRhlALRjBpMUBFGAX6wCIMGs5QQWERAgBkswqHAqMECVSUs4ApVxQpV" +
  "FQE1iROoig2qKlKAF6qKXUqMiwNo838g4Ae6As5WkuGS4hJQOemW+UbM0XGP7amvaxv/PBNi4kgDYi4tNo4QISYJRi2gKUIMQB4viAcAkzD6YUEBAAA=";
