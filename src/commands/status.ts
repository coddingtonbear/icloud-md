import { serializePlanEntry, type SerializedPlanEntry } from "../notes/pushPlan.js";
import { buildPushPlan } from "./push.js";

export interface StatusOptions {
  onLoginStatus?: (message: string) => void;
}

export interface StatusResult {
  entries: SerializedPlanEntry[];
}

/**
 * `git status --short`-style preview of exactly what the next `push` will
 * do: creates, deletes, changes, and anything `push` would refuse and why -
 * built on the exact same plan `push --dry-run` computes, so the two can
 * never disagree. See the "Push becomes the full reconciler" project notes.
 *
 * Unlike the original design for this command, `status` performs a real
 * login and live record fetch (the same one `push --dry-run` already
 * needed) - most refusal reasons only resolve after seeing the current
 * remote record, so there's no way to preserve full refusal parity while
 * also staying offline.
 */
export async function runStatus(targetDir: string, options: StatusOptions = {}): Promise<StatusResult> {
  const { entries } = await buildPushPlan(targetDir, { onLoginStatus: options.onLoginStatus });
  return { entries: entries.map(serializePlanEntry) };
}
