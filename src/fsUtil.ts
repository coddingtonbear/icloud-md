import { lstat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";

/** True if `err` is a Node filesystem error carrying `code` (`ENOENT`,
 * `EACCES`, ...). */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

/** True if `err` is a Node "file not found" error - used by every read path
 * in this project that treats a missing file as "nothing recorded yet"
 * rather than a failure. */
export function isEnoent(err: unknown): boolean {
  return hasErrnoCode(err, "ENOENT");
}

/** What is at `filePath` - file, directory, or a symlink itself (dangling or
 * not; links aren't followed) - or undefined if nothing is. Only "not found"
 * reads as undefined; any other failure is rethrown.
 *
 * Stats come back as bigints on purpose: callers compare `ino` to decide two
 * paths are the same file, and on NTFS a number `ino` can exceed 2^53 and
 * round, so two different files could compare equal. Don't "simplify" this
 * back to plain `lstat`. */
export async function lstatIfPresent(filePath: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(filePath, { bigint: true });
  } catch (cause) {
    if (isEnoent(cause)) {
      return undefined;
    }
    throw cause;
  }
}
