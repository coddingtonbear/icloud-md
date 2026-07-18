import path from "node:path";

/**
 * Derives a human-readable file name for a note from its title alone. The
 * CloudKit recordName that used to be suffixed onto every file for
 * uniqueness now lives only in .icloud-md/state.json (keyed by
 * recordName, with a `file` pointer back to disk) - see uniqueFileName for
 * how title collisions are disambiguated instead.
 */
export function noteFileName(title: string): string {
  const firstLine = title.split("\n")[0]?.trim() ?? "";
  const slug = firstLine
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const base = slug.length > 0 ? slug : "Untitled";

  return `${base}.md`;
}

/**
 * Resolves a candidate file name against names already claimed in this
 * clone/pull run, appending " 2", " 3", etc. (Finder-style) until it's
 * unique. Needed now that file names are derived from title alone, so two
 * notes titled e.g. "New Note" no longer collide.
 */
export function uniqueFileName(fileName: string, usedFileNames: ReadonlySet<string>): string {
  if (!usedFileNames.has(fileName)) {
    return fileName;
  }

  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);

  let n = 2;
  let candidate = `${stem} ${n}${ext}`;
  while (usedFileNames.has(candidate)) {
    n += 1;
    candidate = `${stem} ${n}${ext}`;
  }
  return candidate;
}
