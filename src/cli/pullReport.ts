import type { ChalkInstance } from "chalk";
import type { PullChangeKind, PullSummary } from "../commands/pull.js";
import {
  CHANGED,
  GONE,
  LISTING_INDENT,
  MOVED,
  NEEDS_ATTENTION,
  NEW,
  QUIET,
  UNSYNCABLE,
  labelledLine,
  remarkLine,
} from "./reportStyle.js";

/** Same vocabulary as the push plan's labels where the kinds overlap, so the
 * two screens read as one family; "merged:" and "untracked:" are pull-only
 * outcomes. A merge changed the file in place (yellow, like "modified:");
 * an untrack ends the sync relationship, which is a kind of going-away even
 * though the file itself stays (red, like "deleted:"). */
const LABELS: Record<PullChangeKind, [label: string, color: ChalkInstance]> = {
  add: ["new file:", NEW],
  update: ["modified:", CHANGED],
  merge: ["merged:", CHANGED],
  remove: ["deleted:", GONE],
  move: ["moved:", MOVED],
  untrack: ["untracked:", GONE],
};

const LABEL_WIDTH = Math.max(...Object.values(LABELS).map(([label]) => label.length));

/**
 * Renders a pull's outcome the way `status` renders the push plan: a heading,
 * a blank line, the indented changelist (one coloured label per file, with
 * conflict/read-only remarks indented beneath the entries they belong to), a
 * blank line, and a tally. `formatPath` is the same presentation hook
 * `renderPlan` takes - the CLI passes a cwd-relativizer so paths read from
 * where the user is standing.
 */
export function renderPullReport(summary: PullSummary, formatPath: (file: string) => string = (file) => file): string[] {
  if (summary.changes.length === 0) {
    return [QUIET("Already up to date.")];
  }

  const lines: string[] = ["Changes pulled from iCloud:", ""];
  for (const change of summary.changes) {
    const [label, color] = LABELS[change.kind];
    // Any change can carry a previous path, not just a folder move: a
    // remote retitle renames the file *and* usually rewrites it, and one
    // "modified: Old.md -> New.md" line says that better than a separate
    // move entry saying half of it.
    const subject =
      change.previousFile !== undefined && change.previousFile !== change.file
        ? `${formatPath(change.previousFile)} -> ${formatPath(change.file)}`
        : formatPath(change.file);
    lines.push(LISTING_INDENT + labelledLine(label, color, LABEL_WIDTH, subject));
    for (const remark of change.remarks ?? []) {
      lines.push(
        LISTING_INDENT +
          remarkLine(remark.tone === "conflict" ? NEEDS_ATTENTION : UNSYNCABLE, LABEL_WIDTH, `! ${remark.message}`),
      );
    }
  }

  lines.push("", tallyLine(summary));
  return lines;
}

/** The trailing tally, shaped like `renderPlan`'s: the always-shown counts
 * first, the situational ones only when nonzero, and the needs-attention
 * counts set apart in a parenthetical. */
function tallyLine(summary: PullSummary): string {
  const moved = summary.changes.filter((change) => change.kind === "move").length;
  const untracked = summary.changes.filter((change) => change.kind === "untrack").length;

  let tally = `${summary.added} added, ${summary.updated} updated, ${summary.merged} auto-merged, ${summary.removed} deleted`;
  if (moved > 0) {
    tally += `, ${moved} moved`;
  }
  if (untracked > 0) {
    tally += `, ${untracked} untracked`;
  }
  if (summary.attachmentsDownloaded > 0) {
    tally += `, ${summary.attachmentsDownloaded} attachment(s) downloaded`;
  }
  tally += ".";

  const attention: string[] = [];
  if (summary.conflicts.length > 0) {
    attention.push(`${summary.conflicts.length} conflict(s)`);
  }
  if (summary.unpublishable > 0) {
    attention.push(`${summary.unpublishable} read-only`);
  }
  if (attention.length > 0) {
    tally += ` (${attention.join(", ")})`;
  }
  return tally;
}
