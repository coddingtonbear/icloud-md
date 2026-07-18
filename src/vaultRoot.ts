import { stat } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "./fsUtil.js";
import { STATE_DIR_NAME, STATE_FILE_NAME } from "./notes/cloneState.js";

/**
 * Walks up from `startDir` looking for a cloned vault's
 * `.icloud-md/state.json` - how git finds `.git` - so every command
 * works from anywhere inside the clone. Returns the vault root's absolute
 * path, or undefined when `startDir` isn't inside a clone (callers fall
 * back to "." so the existing not-a-cloned-directory error still names the
 * place the user actually ran the command).
 */
export async function findVaultRoot(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      await stat(path.join(dir, STATE_DIR_NAME, STATE_FILE_NAME));
      return dir;
    } catch (cause) {
      if (!isEnoent(cause)) {
        throw cause;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Renders a vault-root-relative file path relative to the user's current
 * directory - `git status` from a subdirectory shows `../Other/file`, and
 * so do we. Presentation only: state and every internal lookup stay
 * vault-root-relative.
 */
export function displayPath(targetDir: string, file: string, cwd: string = process.cwd()): string {
  return path.relative(cwd, path.resolve(targetDir, file)) || ".";
}
