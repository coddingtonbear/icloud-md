/**
 * Resolves which tracked note (if any) each untracked file *is*, using the
 * `apple-note-id` recorded in its frontmatter.
 *
 * Push sees a renamed or relocated note as two unrelated halves: a tracked
 * file that vanished, and an untracked file that appeared. Pairing them back
 * up used to be guesswork (see `push.ts`'s content-equality and
 * unique-basename fallbacks, which remain for id-less files). With ids in the
 * files, the pairing is exact - and stays exact when a note is renamed,
 * moved, and edited all in one go, which is precisely the case no heuristic
 * could ever recover.
 *
 * The resolution order is id, then path, then create:
 *
 *  - an id matching a tracked note *is* that note;
 *  - a file with no usable id but sitting at a tracked path is that note
 *    (load-bearing: a tracked file whose envelope got stripped by hand must
 *    not silently become a duplicate);
 *  - anything else is a new note, whose id is generated at push time.
 *
 * Nothing here is fatal. An absent id, a malformed one, and one pointing at
 * a note this vault has never heard of all degrade to "this is a new note"
 * rather than an error - a single bad frontmatter value must never fail a
 * whole push. The one exception is a genuinely unresolvable *duplicate*,
 * described under `ambiguous` below.
 */

export interface UntrackedFile {
  /** Vault-root-relative POSIX path. */
  file: string;
  /** The id read from this file's frontmatter, if it had a usable one. */
  noteId?: string | undefined;
}

/** An untracked file paired to the tracked note it turned out to be. */
export interface IdMovePair {
  recordName: string;
  file: string;
}

/** Two or more files claiming one id, with no way to tell which is the
 * original - see `resolveNoteIds`. */
export interface AmbiguousIdClaim {
  recordName: string;
  files: string[];
}

export interface NoteIdResolution {
  /** Untracked files that are really tracked notes which moved or were
   * renamed. Everything here should plan as a move, not a delete + create. */
  moves: IdMovePair[];
  /**
   * Untracked files that are genuinely new notes, in input order. Includes
   * copies of an existing note (the copy is a new note; the original keeps
   * the id) and files carrying stale or malformed ids.
   */
  creates: string[];
  /**
   * Ids claimed by several files where no claimant can be identified as the
   * original - the note's tracked file is gone, so every claimant looks
   * equally like the note that moved. Refusing is the only safe answer:
   * picking wrong would push one copy's text into the real note and orphan
   * the other's history, and neither is recoverable. Callers surface these
   * as refusals telling the user to clear the id from all but one.
   */
  ambiguous: AmbiguousIdClaim[];
  /** Files whose id points at a note this vault doesn't track (a copy from
   * another vault, or a note deleted remotely). They plan as creates; this
   * list exists so the caller can say so rather than doing it silently. */
  staleIds: string[];
}

export interface ResolveNoteIdsInput {
  untracked: readonly UntrackedFile[];
  /** Every tracked note's recordName. */
  trackedRecordNames: Iterable<string>;
  /**
   * Whether a tracked note's own file is still present on disk. A note whose
   * file is present is the *incumbent* for its id: any other file claiming
   * that id is a copy, and becomes a new note. A note whose file is missing
   * is a candidate for having been moved to one of the claimants.
   */
  isTrackedFilePresent: (recordName: string) => boolean;
}

/**
 * Sorts untracked files into moves, creates, and unresolvable duplicates.
 *
 * The incumbent rule is what makes duplicating a note in Obsidian do the
 * obviously right thing: if the original file is still sitting where it was,
 * it keeps the id and the copy becomes a note of its own.
 */
export function resolveNoteIds(input: ResolveNoteIdsInput): NoteIdResolution {
  const tracked = new Set(input.trackedRecordNames);
  const resolution: NoteIdResolution = { moves: [], creates: [], ambiguous: [], staleIds: [] };

  // Group claimants by id first: a decision about any one file depends on
  // how many others claim the same note.
  const claimsById = new Map<string, string[]>();
  for (const candidate of input.untracked) {
    if (candidate.noteId === undefined) {
      continue;
    }
    const files = claimsById.get(candidate.noteId);
    if (files) {
      files.push(candidate.file);
    } else {
      claimsById.set(candidate.noteId, [candidate.file]);
    }
  }

  const resolvedAsMove = new Set<string>();
  const refused = new Set<string>();
  for (const [recordName, files] of claimsById) {
    if (!tracked.has(recordName)) {
      // A stale id: nothing to move, so every claimant is a new note.
      resolution.staleIds.push(...files);
      continue;
    }
    if (input.isTrackedFilePresent(recordName)) {
      // The original is still where it belongs and keeps the id; every
      // claimant here is a copy of it, and becomes a note of its own.
      continue;
    }
    if (files.length > 1) {
      resolution.ambiguous.push({ recordName, files: [...files] });
      for (const file of files) {
        refused.add(file);
      }
      continue;
    }
    const file = files[0];
    if (file !== undefined) {
      resolution.moves.push({ recordName, file });
      resolvedAsMove.add(file);
    }
  }

  for (const candidate of input.untracked) {
    if (!resolvedAsMove.has(candidate.file) && !refused.has(candidate.file)) {
      resolution.creates.push(candidate.file);
    }
  }

  return resolution;
}
