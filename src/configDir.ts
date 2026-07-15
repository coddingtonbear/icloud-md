import os from "node:os";
import path from "node:path";

/** Shared `~/.config/icloud-notes-sync/` root that per-machine files (the
 * debug log, the last-recorded-error file) live under - see also
 * `accountStore.ts`, which stores per-account sessions in the same tree. */
export const CONFIG_DIR = path.join(os.homedir(), ".config", "icloud-notes-sync");
