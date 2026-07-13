import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CloneStateNoteEntry {
  file: string;
  recordChangeTag: string;
  modificationDate: number;
  /** sha256 of the file's content as of the last write, used to detect local hand-edits before overwriting or deleting. */
  contentHash: string;
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

export async function readCloneState(targetDir: string): Promise<CloneState | undefined> {
  const filePath = path.join(targetDir, STATE_DIR_NAME, STATE_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return undefined;
    }
    throw cause;
  }

  const parsed: unknown = JSON.parse(raw);
  return assertCloneState(parsed, filePath);
}

function assertCloneState(value: unknown, filePath: string): CloneState {
  if (typeof value !== "object" || value === null || !isRecord(value) || !isRecord(value.notes)) {
    throw new Error(`${filePath} does not look like a valid state file (missing "notes" object).`);
  }

  const syncToken = typeof value.syncToken === "string" ? value.syncToken : undefined;
  const notes: Record<string, CloneStateNoteEntry> = {};

  for (const [recordName, entry] of Object.entries(value.notes)) {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.recordChangeTag !== "string" ||
      typeof entry.modificationDate !== "number" ||
      typeof entry.contentHash !== "string"
    ) {
      throw new Error(`${filePath} has a malformed entry for note "${recordName}".`);
    }
    notes[recordName] = {
      file: entry.file,
      recordChangeTag: entry.recordChangeTag,
      modificationDate: entry.modificationDate,
      contentHash: entry.contentHash,
    };
  }

  return { syncToken, notes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
