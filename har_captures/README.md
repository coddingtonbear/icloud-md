# HAR capture archive

Browser HAR captures of www.icloud.com's Notes client talking to CloudKit, used to
reverse-engineer the wire format this tool speaks. `CONTRIBUTING.md` asks that any change to
request or response handling be grounded in one of these rather than guessed.

**Everything in this directory except this file is git-ignored** (`/har_captures/*` in
`.gitignore`, and `*.har` globally). A HAR carries live session cookies and tokens, and the
response bodies carry the full content of every note the client touched. Never commit one,
and never attach one to an issue or pull request, public or private.

## Convention

Every `.har` file gets a same-basename `.md` file alongside it, describing what it was
captured to show:

```
har_captures/
  2026-07-15_table-write-edit.har
  2026-07-15_table-write-edit.md
```

**Filename**: `YYYY-MM-DD_short-description.har` (the date captured, not the date named). If
more than one capture happens on the same day, add a distinguishing suffix.

**The `.md` file** carries a `captured:` / `har_file:` frontmatter pair and covers:

- What was done in the browser to produce it, as specifically as possible: which button, what
  was typed, whether the note, table, or attachment already existed or was newly created.
- What question it was captured to answer.
- Once analyzed, a pointer to where the findings live (a code comment, a test fixture, or a
  dev-log entry), so a future reader can find the analysis without re-deriving it from the
  raw HAR.

Code and fixtures reference captures by file name and entry number, for example
`har_captures/2026-07-16_note-lifecycle-create-table-delete.har, entry 56` in
`src/notes/encodeNoteRecord.ts`. Keep that form, so a capture can be found from the code that
depends on it even though the capture itself is not in the repository.

## Taking a capture

1. Open www.icloud.com/notes in a desktop browser. Open the developer tools' Network panel,
   tick *Preserve log* and *Disable cache*, then clear the log.
2. Do exactly one thing to a throwaway note, and nothing else - *one* of: create a note,
   type a line, restyle a table cell, delete a note. One action per capture is what makes
   an entry attributable; a capture spanning four of them is four captures' worth of
   traffic with no way to tell which request came from which action. If the action under
   capture is not the creation itself, create the throwaway note first and clear the log
   again afterwards, so its creation traffic stays out of the capture.
3. Wait for network activity to settle, then export the whole log as a HAR into this
   directory and write the `.md` beside it.

Only the web client can be captured. The native Mac and iOS apps pin their certificates and
speak a different protocol, so a behavior that only they exhibit has to be observed from the
outside (create it on a device, then read the resulting record with `icloud-md object show`).

## Sharing what a capture shows

The capture stays on your machine. What can go in an issue or pull request is a description
of it: the request path, the field names and shapes sent and received, and the order of
calls, with cookies, tokens, `dsid`, record names, and note content left out. If a real
record's bytes are needed as a test fixture, take them from a note that contains nothing but
synthetic filler, and say so where the fixture is defined (see `src/notes/realFixtures.ts`
for the shape). A maintainer can usually reproduce a capture from a good enough description
of the action that produced it.
