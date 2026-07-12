import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CloneStateNoteEntry {
  file: string;
  recordChangeTag: string;
  modificationDate: number;
}

export interface CloneState {
  /** CloudKit syncToken as of this snapshot; a future `pull` resumes incremental sync from here. */
  syncToken: string | undefined;
  notes: Record<string, CloneStateNoteEntry>;
}

const STATE_DIR_NAME = ".icloud-notes-sync";
const STATE_FILE_NAME = "state.json";

export async function writeCloneState(targetDir: string, state: CloneState): Promise<void> {
  const dir = path.join(targetDir, STATE_DIR_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, STATE_FILE_NAME), JSON.stringify(state, null, 2) + "\n", "utf-8");
}
