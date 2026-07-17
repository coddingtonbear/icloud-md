import chalk from "chalk";

/** Which of the three ways a local file can differ from `state.json` this entry represents. */
export type PlanEntryKind = "create" | "update" | "delete";

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
}

const LABELS: Record<PlanEntryKind, (file: string) => string> = {
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
 */
export function renderPlan(entries: readonly PlanEntry[]): string[] {
  const visible = entries.filter((entry) => entry.resolution !== "noop");
  if (visible.length === 0) {
    return ["Nothing to push."];
  }

  const lines: string[] = [];
  let toCreate = 0;
  let toUpdate = 0;
  let toDelete = 0;
  let refused = 0;
  let conflicts = 0;

  for (const entry of visible) {
    lines.push(LABELS[entry.kind](entry.file));
    if (entry.resolution === "refused" || entry.resolution === "conflict") {
      lines.push(chalk.magenta(`  ! ${entry.reason ?? "refused"}`));
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
    } else {
      toDelete += 1;
    }
  }

  let summary = `${toCreate} to create, ${toUpdate} changed, ${toDelete} to delete.`;
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
