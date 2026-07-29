import { mergeDiff3 } from "node-diff3";

export interface MergeOutcome {
  text: string;
  hasConflict: boolean;
}

/**
 * Real 3-way (diff3) merge of a note's base/local/remote text, producing
 * standard git-style diff3 conflict markers (`<<<<<<<` / `|||||||` /
 * `=======` / `>>>>>>>`) when local and remote touch the same region. When
 * local and remote changes don't overlap, this merges cleanly with no
 * markers at all - most editors and diff tools already understand this
 * format.
 */
export function mergeNoteVersions(base: string, local: string, remote: string): MergeOutcome {
  const { conflict, result } = mergeDiff3(splitLines(local), splitLines(base), splitLines(remote), {
    label: { a: "local", o: "base", b: "remote" },
    excludeFalseConflicts: true,
  });

  return { text: result.join("\n"), hasConflict: conflict };
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

/** Matches the diff3 markers `mergeNoteVersions` writes (and git's own, same
 * format). Text carrying these must never be merged again (diff3 over marker
 * text nests markers into soup) nor uploaded - both `push` and `pull` gate
 * on this before touching a modified file. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}( .*)?|\|{7}( .*)?|={7}|>{7}( .*)?)$/m.test(text);
}
