import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";

/**
 * Pristine "last known synced" copy of each note's text, keyed by recordName
 * rather than the note's (renameable) file name. This is the merge ancestor
 * for `pull`'s 3-way (diff3) merge - it only advances once a note is clean
 * or a conflict has been resolved, never while a conflict is outstanding.
 */
const BASE_DIR_SEGMENTS = [".icloud-md", "base"];

export async function readBaseCopy(targetDir: string, recordName: string): Promise<string | undefined> {
  try {
    return await readFile(baseCopyPath(targetDir, recordName), "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return undefined;
    }
    throw cause;
  }
}

export async function writeBaseCopy(targetDir: string, recordName: string, content: string): Promise<void> {
  await mkdir(path.join(targetDir, ...BASE_DIR_SEGMENTS), { recursive: true });
  await writeFile(baseCopyPath(targetDir, recordName), content, "utf-8");
}

export async function removeBaseCopy(targetDir: string, recordName: string): Promise<void> {
  try {
    await rm(baseCopyPath(targetDir, recordName));
  } catch (cause) {
    if (!isEnoent(cause)) {
      throw cause;
    }
  }
}

function baseCopyPath(targetDir: string, recordName: string): string {
  return path.join(targetDir, ...BASE_DIR_SEGMENTS, `${recordName}.md`);
}
