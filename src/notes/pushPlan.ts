import chalk from "chalk";

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

const LABELS: Record<Exclude<PlanEntryKind, "move">, (file: string) => string> = {
  create: (file) => chalk.green(`new file:   ${file}`),
  update: (file) => chalk.yellow(`modified:   ${file}`),
  delete: (file) => chalk.red(`deleted:    ${file}`),
};

/**
 * Renders a push plan `git status --short`-style: one colored line per
 * non-noop entry (green new/yellow modified/red deleted), an indented
 * magenta reason line immediately under anything refused or conflicting,
 * and a trailing summary line. Shared by `push --dry-run`, real `push`, and
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
export function renderPlan(entries: readonly PlanEntry[], formatPath: (file: string) => string = (file) => file): string[] {
  const visible = entries.filter((entry) => entry.resolution !== "noop");
  if (visible.length === 0) {
    return ["Nothing to push."];
  }

  const lines: string[] = [];
  let toCreate = 0;
  let toUpdate = 0;
  let toDelete = 0;
  let toMove = 0;
  let refused = 0;
  let conflicts = 0;

  for (const entry of visible) {
    lines.push(
      entry.kind === "move"
        ? chalk.cyan(`moved:      ${formatPath(entry.previousFile ?? entry.file)} -> ${formatPath(entry.file)}`)
        : LABELS[entry.kind](formatPath(entry.file)),
    );
    if (entry.resolution === "refused" || entry.resolution === "conflict") {
      const reason = (entry.reason ?? "refused").split(entry.file).join(formatPath(entry.file));
      lines.push(chalk.magenta(`  ! ${reason}`));
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
  lines.push(summary);
  return lines;
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
