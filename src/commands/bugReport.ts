import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DEBUG_LOG_PATH, readDebugLogSince, type DebugLogRecord } from "../debugLog.js";
import { CorruptStateFileError } from "../errors.js";
import { DEFAULT_LAST_ERROR_PATH, readLastError, type LastErrorRecord } from "../lastError.js";
import { readCloneState, STATE_DIR_NAME, STATE_FILE_NAME, type CloneState } from "../notes/cloneState.js";
import { getEnvironmentInfo, type EnvironmentInfo } from "../version.js";

export interface BugReportSummary {
  outputPath: string;
  logEntryCount: number;
}

export interface BugReportOptions {
  debugLogPath?: string;
  lastErrorPath?: string;
}

/**
 * Warned before the bundle is written, per the "User-side bug report
 * scaffolding" brainstorm: content is included by default (a garbled table
 * or a dropped note is usually undiagnosable without seeing it), so
 * disclosure - not redaction - is what makes that inclusion an informed
 * choice rather than a silent one.
 */
export const DISCLOSURE_WARNING =
  "This report may include the actual text of your notes (if a recent failure or the included log entries " +
  "touched them) and your Apple ID/account identifier. Review it before attaching it anywhere, including a " +
  "public GitHub issue.";

const SINCE_DURATION_PATTERN = /^(\d+)(m|h|d)$/;

/** Parses a duration like `30m`/`6h`/`2d` into "that long ago from now". No
 * default window is offered on purpose - see the "User-side bug report
 * scaffolding" brainstorm: guessing a range risks silently missing the
 * relevant entries or oversweeping unrelated ones, so the CLI asks rather
 * than assumes. */
export function parseSinceDuration(value: string): Date | undefined {
  const match = SINCE_DURATION_PATTERN.exec(value);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const msPerUnit = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return new Date(Date.now() - Number(match[1]) * msPerUnit[match[2] as "m" | "h" | "d"]);
}

type StateForReport = { status: "ok"; state: CloneState } | { status: "missing" } | { status: "corrupt"; message: string };

/**
 * Wraps `readCloneState` so a corrupt `state.json` degrades to a reportable
 * fact instead of crashing the one command meant to help after something's
 * gone wrong - a bug-report run is disproportionately likely to hit exactly
 * this case.
 */
async function readStateForReport(targetDir: string): Promise<StateForReport> {
  try {
    const state = await readCloneState(targetDir);
    return state ? { status: "ok", state } : { status: "missing" };
  } catch (error) {
    if (error instanceof CorruptStateFileError) {
      return { status: "corrupt", message: error.message };
    }
    throw error;
  }
}

/**
 * Bundles everything needed to troubleshoot a failure - tool/environment
 * version, the last recorded error, this folder's `state.json` (if
 * present), and the debug-log slice since `since` - into one Markdown file
 * the user can attach to a GitHub issue.
 */
export async function runBugReport(targetDir: string, since: Date, options: BugReportOptions = {}): Promise<BugReportSummary> {
  console.warn(DISCLOSURE_WARNING);

  const [lastError, state, logEntries] = await Promise.all([
    readLastError(options.lastErrorPath ?? DEFAULT_LAST_ERROR_PATH),
    readStateForReport(targetDir),
    readDebugLogSince(since, options.debugLogPath ?? DEFAULT_DEBUG_LOG_PATH),
  ]);
  const environment = getEnvironmentInfo();
  const generatedAt = new Date();

  const outputPath = path.join(targetDir, `icloud-notes-bug-report-${formatFileTimestamp(generatedAt)}.md`);
  await writeFile(
    outputPath,
    renderBundle({ environment, lastError, state, logEntries, since, targetDir, generatedAt }),
    "utf-8",
  );

  console.log(`Wrote ${outputPath}`);
  return { outputPath, logEntryCount: logEntries.length };
}

function renderBundle(input: {
  environment: EnvironmentInfo;
  lastError: LastErrorRecord | undefined;
  state: StateForReport;
  logEntries: DebugLogRecord[];
  since: Date;
  targetDir: string;
  generatedAt: Date;
}): string {
  const { environment, lastError, state, logEntries, since, targetDir, generatedAt } = input;
  const lines: string[] = [];

  lines.push("# icloud-notes-sync bug report", "", `Generated: ${generatedAt.toISOString()}`, "");

  lines.push("## Environment");
  lines.push(`- Tool version: ${environment.toolVersion}`);
  lines.push(`- Node version: ${environment.nodeVersion}`);
  lines.push(`- Platform: ${environment.platform} (${environment.osRelease})`, "");

  lines.push("## Last recorded error");
  if (lastError) {
    lines.push(`- Timestamp: ${lastError.timestamp}`);
    lines.push(`- Message: ${lastError.message}`);
    if (lastError.hint) {
      lines.push(`- Hint: ${lastError.hint}`);
    }
  } else {
    lines.push("No failure has been recorded on this machine yet.");
  }
  lines.push("");

  const stateFilePath = path.join(targetDir, STATE_DIR_NAME, STATE_FILE_NAME);
  lines.push(`## Local state (\`${stateFilePath}\`)`);
  if (state.status === "ok") {
    lines.push("```json", JSON.stringify(state.state, null, 2), "```");
  } else if (state.status === "corrupt") {
    lines.push(`\`${stateFilePath}\` exists but couldn't be read: ${state.message}`);
  } else {
    lines.push(`No \`${STATE_DIR_NAME}/${STATE_FILE_NAME}\` found in \`${targetDir}\` - this may not be a cloned notes directory.`);
  }
  lines.push("");

  lines.push(`## Debug log entries since ${since.toISOString()} (${logEntries.length})`);
  if (logEntries.length > 0) {
    lines.push("```json", JSON.stringify(logEntries, null, 2), "```");
  } else {
    lines.push("No debug log entries fall within this time range.");
  }
  lines.push("");

  return lines.join("\n");
}

function formatFileTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}
