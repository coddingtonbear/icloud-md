import path from "node:path";
import { carriedTitleSpelling, encodeTitleStem, titleIsRepresentable } from "./titleFilename.js";

/**
 * The file name for a note, given how this vault carries titles.
 *
 * In-body mode keeps `noteFileName`'s destructive sanitizing: the name is
 * only a display convenience there, since the title also sits in the file.
 * Filename mode uses the reversible projection instead, because the name is
 * the only place the title lives - reversible up to trailing whitespace,
 * which the name drops (see `carriedTitleSpelling`) - and falls back to
 * "Untitled" for a title a name genuinely can't carry, with the real one
 * recorded in `apple-note-title` frontmatter by the caller.
 */
export function noteFileNameFor(titleLine: string, titleMode: "in-body" | "filename"): string {
  if (titleMode !== "filename") {
    return noteFileName(titleLine);
  }
  const firstLine = titleLine.split("\n")[0] ?? "";
  return titleIsRepresentable(firstLine) ? `${encodeTitleStem(carriedTitleSpelling(firstLine))}.md` : "Untitled.md";
}

/**
 * The note's real title when a file name can't carry it, for the caller to
 * record in `apple-note-title` frontmatter - and undefined whenever the name
 * is enough, which is nearly always.
 *
 * The exact complement of `noteFileNameFor`'s "Untitled.md" fallback: these
 * two answer the same question ("can the name hold this?") and must never
 * disagree, so they're kept side by side and both defer to
 * `titleIsRepresentable`.
 */
export function titleNeedingFrontmatter(titleLine: string, titleMode: "in-body" | "filename"): string | undefined {
  if (titleMode !== "filename") {
    return undefined;
  }
  const firstLine = titleLine.split("\n")[0] ?? "";
  // An empty title is unrepresentable, but there's nothing to record: the
  // note really is untitled, so "Untitled.md" is the whole truth about it
  // and a frontmatter key holding "" would only be read back as absent.
  if (firstLine.trim() === "") {
    return undefined;
  }
  return titleIsRepresentable(firstLine) ? undefined : firstLine;
}

/**
 * Whether a file name already carries this title, in a vault where the name
 * *is* the title - either the name the title derives, or one of the
 * uniquified spellings `uniqueFileName` produces when two notes want the
 * same one.
 *
 * The uniquifier is why this can't just be a string comparison. A second
 * note titled "Foo" lands at `Foo 2.md`, whose stem decodes to "Foo 2" - so
 * comparing the decoded name against the title would call every uniquified
 * file a retitle and rename it on every pull, walking it up through "Foo 3",
 * "Foo 4"... The title a name was derived from is not always recoverable
 * from the name; whether the name is *acceptable* for the title always is,
 * and that's the question a rename decision actually asks.
 */
export function fileNameCarriesTitle(fileName: string, titleLine: string): boolean {
  const wanted = noteFileNameFor(titleLine, "filename");
  if (fileName === wanted) {
    return true;
  }
  const extension = path.extname(wanted);
  const stem = wanted.slice(0, wanted.length - extension.length);
  if (!fileName.endsWith(extension)) {
    return false;
  }
  const actual = fileName.slice(0, fileName.length - extension.length);
  if (!actual.startsWith(`${stem} `)) {
    return false;
  }
  // Only the uniquifier's own suffixes count: " 2" onwards, digits alone.
  // A note genuinely titled "Foo 2" matches the exact comparison above
  // instead, so nothing here has to distinguish the two.
  const suffix = actual.slice(stem.length + 1);
  return /^[0-9]+$/.test(suffix) && Number(suffix) >= 2;
}

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
