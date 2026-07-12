/**
 * Derives a stable, human-readable file name for a note. Includes a short
 * suffix from the record's own recordName (a UUID for real "Note" records)
 * so two notes with the same title don't collide and so the file can be
 * traced back to its CloudKit record at a glance.
 */
export function noteFileName(title: string, recordName: string): string {
  const firstLine = title.split("\n")[0]?.trim() ?? "";
  const slug = firstLine
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const base = slug.length > 0 ? slug : "Untitled";

  const shortId = recordName.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();

  return `${base} (${shortId}).md`;
}
