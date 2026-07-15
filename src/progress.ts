/**
 * Progress-reporting contract shared by `runClone`/`runPull`. These commands
 * never touch stdout/stderr directly (so they stay usable as a library) -
 * this is the only channel they use to report progress; rendering it (or
 * not) is entirely up to the caller.
 */
export interface SyncProgress {
  onFetchPage?: (recordsSoFar: number) => void;
  onProcessStart?: (totalRecords: number) => void;
  onRecordProcessed?: () => void;
  onProcessComplete?: () => void;
}
