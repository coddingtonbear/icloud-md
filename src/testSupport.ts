import { link } from "node:fs/promises";
import { hasErrnoCode } from "./fsUtil.js";

/**
 * Test setup: makes `to` a second name for the file at `from`, where the two
 * differ only in case - what a case-insensitive disk (APFS, NTFS) gives for
 * free. A case-sensitive disk needs a hard link to fake it; on a
 * case-insensitive one the two names are already one file, so the link
 * fails with EEXIST and there is nothing left to do.
 */
export async function aliasCase(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error) {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  }
}
