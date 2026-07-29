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
 * pairing a missing tracked file with an untracked one - see push.ts). */
export type PlanEntryKind = "create" | "update" | "delete" | "move";

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
  /** kind "move" only: the vault-root-relative path the note was tracked
   * at before the local move. */
  previousFile?: string;
}

/** Borrowed from `git status` verbatim, because a person who has used git
 * already knows what these words mean. Only the label carries the colour -
 * the filename after it stays in the terminal's own foreground. */
const LABELS: Record<PlanEntryKind, [label: string, color: ChalkInstance]> = {
  create: ["new file:", NEW],
  update: ["modified:", CHANGED],
  delete: ["deleted:", GONE],
  move: ["moved:", MOVED],
};

/** Labels are padded to a common width so the listing reads as a column
 * rather than a ragged list. */
const LABEL_WIDTH = Math.max(...Object.values(LABELS).map(([label]) => label.length));


export interface RenderPlanOptions {
  /** Dresses the listing as the status screen: a "Changes not yet pushed
   * to iCloud:" heading with next-step hints above the change list, the
   * list indented beneath it. Used by the previews (`status` and `push
   * --dry-run`); a real `push` keeps the bare listing, since by then the
   * entries are outcomes rather than things "not yet pushed". */
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

  const indent = options.preview === true ? LISTING_INDENT : "";
  const lines: string[] = [];
  if (options.preview === true) {
    lines.push(
      "Changes not yet pushed to iCloud:",
      QUIET('  (use "icloud-md push" to send them)'),
      QUIET('  (use "icloud-md restore <file>" to discard a local edit)'),
      "",
    );
  }
  let toCreate = 0;
  let toUpdate = 0;
  let toDelete = 0;
  let toMove = 0;
  let refused = 0;
  let conflicts = 0;

  for (const entry of visible) {
    const [label, color] = LABELS[entry.kind];
    const subject =
      entry.kind === "move"
        ? `${formatPath(entry.previousFile ?? entry.file)} -> ${formatPath(entry.file)}`
        : formatPath(entry.file);
    lines.push(indent + labelledLine(label, color, LABEL_WIDTH, subject));
    if (entry.resolution === "refused" || entry.resolution === "conflict") {
      const reason = (entry.reason ?? "refused").split(entry.file).join(formatPath(entry.file));
      lines.push(indent + remarkLine(entry.resolution === "refused" ? UNSYNCABLE : NEEDS_ATTENTION, LABEL_WIDTH, `! ${reason}`));
      if (entry.resolution === "refused") {
        refused += 1;
      } else {
        conflicts += 1;
      }
      continue;
    }
    if (entry.kind === "create") {
      toCreate += 1;
    } else if (entry.kind === "update") {
      toUpdate += 1;
    } else if (entry.kind === "move") {
      toMove += 1;
    } else {
      toDelete += 1;
    }
  }

  let summary = `${toCreate} to create, ${toUpdate} changed, ${toDelete} to delete${toMove > 0 ? `, ${toMove} to move` : ""}.`;
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
 * matching how the listing hides it.
 */
export function countUnchangedNotes(entries: readonly Pick<PlanEntry, "kind" | "resolution">[], trackedNotes: number): number {
  const touched = entries.filter((entry) => entry.kind !== "create" && entry.resolution !== "noop").length;
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
export type SerializedPlanEntry = Pick<PlanEntry, "kind" | "file" | "resolution" | "reason" | "previousFile">;

/** Projects any `PlanEntry` (including `push`'s `ExecutablePlanEntry`, which
 * extends it with `execute`) down to its serializable fields. */
export function serializePlanEntry(entry: PlanEntry): SerializedPlanEntry {
  const { kind, file, resolution, reason, previousFile } = entry;
  return {
    kind,
    file,
    resolution,
    ...(reason !== undefined ? { reason } : {}),
    ...(previousFile !== undefined ? { previousFile } : {}),
  };
}
