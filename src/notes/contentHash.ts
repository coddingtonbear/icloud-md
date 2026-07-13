import { createHash } from "node:crypto";

/** Used to detect whether a local note file has been hand-edited since we last wrote it. */
export function hashNoteContent(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}
