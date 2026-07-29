/**
 * Progress-reporting contract shared by `runClone`/`runPull`. These commands
 * never touch stdout/stderr directly (so they stay usable as a library) -
 * this is the only channel they use to report progress; rendering it (or
 * not) is entirely up to the caller.
 */
/**
 * A human-readable event worth surfacing in a command's final summary
 * (`runClone`/`runPull` collect these instead of printing - same
 * stay-usable-as-a-library rule as `SyncProgress` below).
 */
export interface SyncNotice {
  level: "info" | "warn";
  message: string;
}

export interface SyncProgress {
  /**
   * Fetching is about to begin - sign-in (which may print its own output,
   * including a first-run browser download's progress) is complete. Callers
   * rendering a live spinner should not start it before this fires, or it
   * will redraw over the login flow's output.
   */
  onFetchStart?: () => void;
  onFetchPage?: (recordsSoFar: number) => void;
  onProcessStart?: (totalRecords: number) => void;
  onRecordProcessed?: () => void;
  onProcessComplete?: () => void;
}
