import type { ChalkInstance } from "chalk";
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
} from "../cli/reportStyle.js";

/** Which of the ways a local file can differ from `state.json` this entry
 * represents. "move" is a locally-relocated tracked note (detected by
 * pairing a missing tracked file with an untracked one - see push.ts).
 * "rename" is the odd one out: not something push will do, but something the
 * reader still has to - a rename `pull --defer-renames` handed off and
 * nobody has performed. */
export type PlanEntryKind =
  "create" | "createFolder" | "update" | "delete" | "move" | "rename";

/**
 * "noop" covers both a clean tracked file (nothing to do) and a "modified"
 * one whose only difference from the base copy turned out not to matter
 * (e.g. a table diff that resolved to no server-side change) - in both
 * cases there's genuinely nothing to show the user, matching how `git
 * status` omits a file with no effective diff.
 */
export type PlanResolution = "ready" | "refused" | "conflict" | "noop";

export interface PlanEntry {
  kind: PlanEntryKind;
  file: string;
  resolution: PlanResolution;
  /** Required for "refused"/"conflict"; ignored otherwise. */
  reason?: string;
  /** kind "createFolder" only: `file` is a directory path rather than a
   * note, and this is the Notes folder title it will be given. */
  folderTitle?: string;
  /** kind "move" only: the vault-root-relative path the note was tracked
   * at before the local move. */
  previousFile?: string;
  /** kind "rename" only: the vault-root-relative path this file is supposed
   * to be renamed to. Structured rather than spelled out in `reason` because
   * the consumer that performs the rename reads this listing as JSON. */
  pendingRename?: string;
  /** Something true about an entry that is going through fine - shown in the
   * quiet tone under the entry's line, where `reason` would sit for one that
   * isn't. For consequences the user can't infer from the label alone, like
   * a retitle whose file rename lands on the next pull. */
  remark?: string;
}

/** Borrowed from `git status` verbatim, because a person who has used git
 * already knows what these words mean. Only the label carries the colour -
 * the filename after it stays in the terminal's own foreground. */
const LABELS: Record<PlanEntryKind, [label: string, color: ChalkInstance]> = {
  create: ["new file:", NEW],
  // "new dir:" rather than "new folder:" so the label column stays the
  // width it has always been - a longer label here would re-indent every
  // listing, including the vast majority that never create a folder. The
  // subject carries a trailing slash, and the summary says "folder".
  createFolder: ["new dir:", NEW],
  update: ["modified:", CHANGED],
  delete: ["deleted:", GONE],
  move: ["moved:", MOVED],
  rename: ["rename:", MOVED],
};

/** Labels are padded to a common width so the listing reads as a column
 * rather than a ragged list. */
const LABEL_WIDTH = Math.max(
  ...Object.values(LABELS).map(([label]) => label.length),
);

export interface RenderPlanOptions {
  /** Dresses the listing as the status screen: a "Changes not yet pushed
   * to iCloud:" heading with next-step hints above the change list. Used
   * by the previews (`status` and `push --dry-run`); a real `push` skips
   * the heading - its own "Pushed N note(s) from ..." line sits above the
   * listing instead - but keeps the same indentation and surrounding blank
   * lines, so all the changelist screens share one shape. */
  preview?: boolean;
  /** How many tracked notes the plan left untouched (see
   * `countUnchangedNotes`) - enables the trailing "N other note(s) match
   * the last pull." remark, and its "Nothing to push" variant. */
  unchanged?: number;
}

/**
 * Renders a push plan `git status`-style: one line per non-noop entry with
 * a colored label column and plain filename, an indented reason line
 * immediately under anything refused (black-on-red - push will never sync
 * it as-is) or conflicting (magenta - resolvable, then retry), and a
 * trailing summary line. Shared by `push --dry-run`, real `push`, and
 * `status` so the three can never show different things for the same state
 * - see the "Push becomes the full reconciler" project notes.
 *
 * `formatPath` is the presentation hook for git-style cwd-relative output:
 * entries keep vault-root-relative paths internally, and the CLI passes a
 * formatter that re-expresses them relative to the user's current
 * directory. It's also applied to occurrences of the path *inside* reason
 * lines (restore-command hints and the like), so suggested commands stay
 * copy-pasteable from wherever the user is standing.
 */
export function renderPlan(
  entries: readonly PlanEntry[],
  formatPath: (file: string) => string = (file) => file,
  options: RenderPlanOptions = {},
): string[] {
  const visible = entries.filter((entry) => entry.resolution !== "noop");
  if (visible.length === 0) {
    return [
      QUIET(
        options.unchanged !== undefined && options.unchanged > 0
          ? `Nothing to push; all ${options.unchanged} ${options.unchanged === 1 ? "note matches" : "notes match"} the last pull.`
          : "Nothing to push.",
      ),
    ];
  }

  const lines: string[] = [];
  if (options.preview === true) {
    lines.push(
      "Changes not yet pushed to iCloud:",
      QUIET('  (use "icloud-md push" to send them)'),
      QUIET('  (use "icloud-md restore <file>" to discard a local edit)'),
      "",
    );
  } else {
    lines.push("");
  }
  let toCreate = 0;
  let toCreateFolder = 0;
  let toUpdate = 0;
  let toDelete = 0;
  let toMove = 0;
  let refused = 0;
  let conflicts = 0;

  for (const entry of visible) {
    const [label, color] = LABELS[entry.kind];
    const subject =
      entry.kind === "createFolder"
        ? `${formatPath(entry.file)}/`
        : entry.kind === "move"
          ? `${formatPath(entry.previousFile ?? entry.file)} -> ${formatPath(entry.file)}`
          : entry.kind === "rename" && entry.pendingRename !== undefined
            ? `${formatPath(entry.file)} -> ${formatPath(entry.pendingRename)}`
            : formatPath(entry.file);
    lines.push(
      LISTING_INDENT + labelledLine(label, color, LABEL_WIDTH, subject),
    );
    if (entry.resolution === "refused" || entry.resolution === "conflict") {
      const reason = (entry.reason ?? "refused")
        .split(entry.file)
        .join(formatPath(entry.file));
      lines.push(
        LISTING_INDENT +
          remarkLine(
            entry.resolution === "refused" ? UNSYNCABLE : NEEDS_ATTENTION,
            LABEL_WIDTH,
            `! ${reason}`,
          ),
      );
      if (entry.resolution === "refused") {
        refused += 1;
      } else {
        conflicts += 1;
      }
      continue;
    }
    if (entry.remark !== undefined) {
      lines.push(LISTING_INDENT + remarkLine(QUIET, LABEL_WIDTH, entry.remark));
    }
    if (entry.kind === "create") {
      toCreate += 1;
    } else if (entry.kind === "createFolder") {
      toCreateFolder += 1;
    } else if (entry.kind === "update") {
      toUpdate += 1;
    } else if (entry.kind === "move") {
      toMove += 1;
    } else if (entry.kind === "delete") {
      toDelete += 1;
    }
  }

  let summary =
    `${toCreate} to create, ${toUpdate} changed, ${toDelete} to delete` +
    `${toMove > 0 ? `, ${toMove} to move` : ""}` +
    `${toCreateFolder > 0 ? `, ${toCreateFolder} new folder${toCreateFolder === 1 ? "" : "s"}` : ""}.`;
  if (conflicts > 0 || refused > 0) {
    const parts: string[] = [];
    if (conflicts > 0) {
      parts.push(`${conflicts} conflict(s)`);
    }
    if (refused > 0) {
      parts.push(`${refused} refused`);
    }
    summary += ` (${parts.join(", ")})`;
  }
  lines.push("", summary);
  if (options.unchanged !== undefined && options.unchanged > 0) {
    lines.push(
      QUIET(
        options.unchanged === 1
          ? "1 other note matches the last pull."
          : `${options.unchanged} other notes match the last pull.`,
      ),
    );
  }
  return lines;
}

/**
 * How many tracked notes a plan left untouched - the "N other notes match
 * the last pull." figure. Every non-create entry (update/delete/move)
 * accounts for exactly one tracked note; creates are untracked files, and a
 * clean tracked note produces no entry at all. A "noop" update (a byte-level
 * difference that resolved to no server-side change) counts as unchanged,
 * matching how the listing hides it. So does a "rename": what's out of step
 * there is the file's *name*, not the note, and the same note can carry a
 * real change entry alongside it - counting both would make the tally
 * describe more notes than the vault has.
 */
export function countUnchangedNotes(
  entries: readonly Pick<PlanEntry, "kind" | "resolution">[],
  trackedNotes: number,
): number {
  const touched = entries.filter(
    (entry) =>
      entry.kind !== "create" &&
      entry.kind !== "rename" &&
      entry.resolution !== "noop",
  ).length;
  return Math.max(0, trackedNotes - touched);
}

/** Strips a `"<file>: "` prefix a refusal/conflict message was built with, so
 * it can be shown as the reason line under a plan entry without repeating
 * the filename `renderPlan` already printed on the line above it. */
export function stripFilePrefix(message: string, file: string): string {
  const prefix = `${file}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/** A `PlanEntry` projected to its plain-data fields - what `status` and
 * `push --dry-run` both hand to `--json` callers (dropping `push`'s
 * `execute` closure, which isn't serializable and isn't anyone's business
 * outside this process). */
export type SerializedPlanEntry = Pick<
  PlanEntry,
  | "kind"
  | "file"
  | "resolution"
  | "reason"
  | "previousFile"
  | "pendingRename"
  | "folderTitle"
  | "remark"
>;

/** Projects any `PlanEntry` (including `push`'s `ExecutablePlanEntry`, which
 * extends it with `execute`) down to its serializable fields. */
export function serializePlanEntry(entry: PlanEntry): SerializedPlanEntry {
  const {
    kind,
    file,
    resolution,
    reason,
    previousFile,
    pendingRename,
    folderTitle,
    remark,
  } = entry;
  return {
    kind,
    file,
    resolution,
    ...(reason !== undefined ? { reason } : {}),
    ...(previousFile !== undefined ? { previousFile } : {}),
    ...(pendingRename !== undefined ? { pendingRename } : {}),
    ...(folderTitle !== undefined ? { folderTitle } : {}),
    ...(remark !== undefined ? { remark } : {}),
  };
}
