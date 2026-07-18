# icloud-md

A command-line tool for syncing Apple Notes (via iCloud) to a local folder
of plain files — and back again. `git`-flavored in spirit: a single binary,
a working tree, and explicit `clone`/`pull`/`push` commands rather than a
background daemon. It doesn't touch git itself, but the folder it writes is
exactly the kind of thing you'd want to put under git.

```
$ icloud-md clone ./my-notes
$ cd my-notes && $EDITOR "Grocery list.md"
$ icloud-md push
```

## Why

Apple Notes has no supported way to get your notes onto disk as plain files.
This tool exists to fix that:

- **Your notes become real files**, editable in whatever editor you already
  use, versionable in git, greppable, diffable, and scriptable — instead of
  being locked inside Notes.app or the iCloud web client.
- **Plain markdown files**: `clone` writes one Markdown
  file per note into a folder you control; `pull` and `push` keep it in sync
  with iCloud in both directions.
- **Built-in version history**: Every `pull`/`push` that
  changes a note snapshots it, so you can inspect or roll back *any* past
  version of a note — even ones you never `pull`ed while they existed — via
  `icloud-md history`/`diff`/`revert`.
- **Conflict-awareness**: If a note changed in iCloud
  since your last sync *and* you edited it locally, `pull` does a real
  three-way merge and only asks you to resolve the parts that actually
  overlap — the rest merges automatically.
- **`git`-flavored CLI**: You're probably familiar with what the various
  `git` do; that knowledge is most of what you need to know to use this
  tool.

> [!WARNING]
> **This is not an official or supported Apple API.** It works by
> reverse-engineering the private CloudKit web service that
> `www.icloud.com/notes` itself talks to, and by reverse-engineering the
> format Notes uses to store note content. Apple can change either of those
> at any time without notice.
> 
> **Data loss is a real possibility, not a hypothetical one.** `push`,
> `delete`, and `revert` all make real writes to your live Notes account
> based on this tool's own reverse-engineered understanding of Apple's
> formats, not documented behavior. This tool's own version-history snapshots
> (`history`/`diff`/`revert`) are a real safety net, but you should not
> assume they're infallible, and you should not treat this tool as a
> substitute for a real backup.
> 
> **Use this at your own risk, on your own account, and only against a
> working tree that's also a git repo** (or otherwise backed up) so you always
> have an independent copy of your notes outside of iCloud and outside of this
> tool. Before relying on `push` (or `delete`, or `revert`) against notes you
> care about, try it first against a disposable test note.
> 
> A few things follow directly from the reverse-engineering:
> 
> - It likely **requires Advanced Data Protection (ADP) to be disabled** on
>   the account — with ADP on, note content is end-to-end encrypted in a way
>   this tool doesn't attempt to decrypt.
> - Login itself is **not** reverse-engineered: `clone`/`reauthenticate` open
>   a real, headed browser window and let Apple's own sign-in pages (password,
>   2FA, CAPTCHAs) run to completion, then harvest the resulting session. This
>   keeps the tool out of the business of replicating Apple's login protocol,
>   which changes far more often than the sync API does.

## Install

Requires Node.js 20+.

```
npm install -g icloud-md
```

This puts the `icloud-md` command on your `PATH`.

Building from a clone of this repo instead:

```
git clone https://github.com/coddingtonbear/icloud-md.git
cd icloud-md
npm install
npm run build && npm link
```

(Re-run `npm run build` after pulling source changes.)

## Quick start

```
icloud-md clone ./my-notes
```

The first run downloads a Chromium browser for sign-in automatically (a
one-off ~150 MB fetch), then opens it against `www.icloud.com` — sign in as
you normally would (password, 2FA, whatever your account requires). The
command detects sign-in completion on its own and closes the window;
closing it yourself aborts the clone. This walks your whole Notes zone
(including notes shared with you) and writes one Markdown file per note into
`./my-notes`, mirroring your Apple Notes folder structure — each note lands
in the same (sub)folder it's in inside Notes.app, with each sharer's notes
under a top-level directory named for them — and downloading any
attachments alongside their note.

After that:

```
cd my-notes
icloud-md status        # what would `push` do right now?
icloud-md pull          # fetch remote changes, merging with local edits
icloud-md push          # send local changes back to iCloud
```

Later sign-ins for the same Apple ID typically skip 2FA — each account gets
its own persistent browser profile under
`~/.config/icloud-md/accounts/<dsid>/`, which Apple treats as a
trusted, returning browser. Credentials are never stored inside the vault
folder itself (a vault is exactly the kind of thing that gets copied,
zipped, or synced elsewhere); a cloned folder's own
`.icloud-md/state.json` only records *which* account it's bound to.

## Commands

| Command | What it does |
| --- | --- |
| `clone <directory>` | Full initial export into a fresh directory: every note, attachments included. Signs in via a browser window the first time a directory (or Apple ID) is used. Refuses to run against an already-cloned directory — use `pull` there instead. |
| `pull [directory]` | Fetch everything that changed remotely since the last sync; auto-merges non-overlapping local edits, writes conflict markers for overlapping ones. Defaults to the current directory. |
| `push [directory] [--dry-run]` | Reconcile local disk state up to iCloud: creates notes for new `.md` files, uploads edited notes, moves notes whose file was deleted locally to Recently Deleted, and merges in remote changes to anything edited on both sides. Refuses anything ambiguous rather than guessing. |
| `status [directory]` | Preview exactly what the next `push` would do — creates, edits, deletes, and any refusals — without writing anything. Runs the same live checks `push --dry-run` does, so it needs to sign in. |
| `restore <file> [directory]` | Discard a tracked note's *local, uncommitted* edits, reverting the file to the last-synced copy. Purely local, no network call. |
| `delete <file> [directory] [--hard]` | Move a note to Recently Deleted (recoverable in Notes for ~30 days) and stop tracking it locally, keeping the locally-edited copy on disk as an untracked file. `--hard` permanently deletes instead — works even on attachment-bearing or unparseable notes, and on a note already soft-deleted. This is a real remote write with no confirmation prompt. |
| `history <file> [directory] [--records]` | List a note's version-history timeline, newest first. |
| `diff <file> <ref> [directory]` | Diff two history snapshots, or one snapshot against the current remote copy. `<ref>` is a snapshot/epoch id from `history`, or `<from>..<to>`. |
| `revert <file> <id> [directory] [--yes]` | Write a historical snapshot back to the server — the escape hatch if a note gets corrupted or a bad edit gets pushed. A real remote write; without `--yes` it only reports what it would do. |
| `object <list\|show\|delete>` | Record-level plumbing for repairing broken notes: list every raw CloudKit record in your Notes zone with health/reference info, inspect one record in full, or permanently delete one by ID. Run `icloud-md object` with no arguments for the full usage. |
| `reauthenticate [directory]` | Force a fresh sign-in for a directory's already-bound account. Useful if a session goes stale and silent recovery can't get back in on its own. Refuses if you sign into a different Apple ID than the one the directory was cloned for. |
| `verify-auth [directory]` | Check whether a directory's bound account session is still valid. |
| `bug-report --since <duration> [directory]` | Bundle version info, the last error, local sync state, and recent debug-log entries into a file to attach to a GitHub issue (e.g. `--since 2h`). |

No `commit`/`branch`/`merge` equivalents exist — the working directory *is*
the local state, and the git repo you presumably wrapped around it (or the
`history`/`diff`/`revert` trio above) is where history and conflict
resolution live.

## What works today

- **`clone`/`pull`/`push` for plain-text notes**, including notes shared
  with you, with real three-way merging on `pull`.
- **Your Apple Notes folder structure is mirrored on disk** `pull` reconciles remote
  folder renames/moves by moving the note's file rather than the
  directory, and `push` picks up local moves between folders (a rename or
  `mv` of a tracked file) and sends the matching folder change upstream.
  Notes shared with you live under a top-level directory per sharer, with
  their own shared folders nested underneath. All commands are
  `git`-style about it — run them from anywhere inside the vault and file
  arguments resolve relative to your current directory.
- **`push` as a full reconciler**: creating notes from new local files,
  uploading edits, moving notes between folders, and
  moving deleted-locally notes to Recently Deleted — all gated by an
  optimistic-lock check against the note's remote change tag, so a note
  that changed remotely since your last sync is reported as a conflict,
  never silently overwritten.
- **Rich-text formatting round-trips, not just plain text.** Headings,
  ordered/unordered/nested lists (including custom start numbers),
  checklists, blockquotes, fenced monospace blocks, and inline
  bold/italic/strikethrough/underline/links render to real Markdown on
  `pull`/`clone` and push back as the matching Apple formatting on edit.
  Anything this tool doesn't fully understand about a note's formatting
  stays read-only rather than risking a bad write.
- **Writing to notes shared with you is supported for creates and edits**
  inside a shared folder you have write access to — not just the read
  side. See Known limitations for what's still refused.
- **Attachments** (images and audio confirmed): downloaded and rewritten
  into note text as `attachments/`-relative links (attachments live
  alongside the note in its own folder); re-downloaded only when the
  remote file's checksum actually changes.
- **Table edits.** Cell edits, and inserting/deleting a contiguous run of
  rows or columns, round-trip both ways. Row/column *reordering*, and any
  edit that adds/removes rows and columns in the same save, are refused
  rather than risking a bad write — split a reorder into a delete push
  followed by an insert push instead.
- **`delete`/`delete --hard`**, and the `object` repair-kit commands, for
  cleaning up notes this tool (or anything else) leaves in a broken state.
- **`history`/`diff`/`revert`**, and push-time auto-merge via version
  history — the safety net for inspecting or undoing a bad edit.

## Known limitations

- **Regular file attachments (images, audio, other files) are permanently
  read-only** `push` will always refuse to write back
  a note that has a non-table attachment, since this tool doesn't fully
  parse that part of a note's internal format and editing one back risks
  corrupting it. `restore <file>` discards any local edit to get back to a
  clean copy. (Tables are the one exception — see above.)
- **Attachment upload is not supported, and isn't planned.** The iCloud web
  Notes editor itself has no way to attach a new file to a note, so there's
  no legitimate client behavior to reverse-engineer here.
- **Shared-note attachments are unverified.** The download code path should
  work (it mirrors how shared note text already does), but no shared note
  with an attachment has actually been observed live yet.
- **Some writes to notes shared with you are still refused.** Deleting a
  shared note, and renaming/moving one between folders, aren't supported
  (Apple's own web client can't do the former either). A note that's
  individually shared with you rather than living in a shared folder — or
  sitting loose at the top of a sharer's area rather than inside one of
  their shared folders — is refused as a create/edit target too. A
  shared folder you only have read access to is correctly refused, but
  that path is still unverified live (no read-only share has been
  available to test against).
- **No real-time or continuous sync.** This is a deliberate fetch/push
  tool, not a background daemon.
- **Concurrent edits from *other* Apple devices aren't merged the way Notes
  itself does internally.** `pull`'s three-way merge is a real text diff
  (auto-merging non-overlapping edits, flagging overlapping ones), not a
  reimplementation of Notes' own internal merge behavior.
- **Formatting fidelity has edges.** Hashtags/mentions aren't handled yet;
  a handful of rare cases (list groups that start above the top indent
  level, some unusual CommonMark adjacency, blockquotes that round-trip
  correctly but don't actually render in the iCloud web client) fall back
  to read-only rather than risk a mis-parse.

## How it works

The iCloud web client talks directly to CloudKit's private database web
service for the `com.apple.notes` container
(`https://p<N>-ckdatabasews.icloud.com/database/1/com.apple.notes/...`),
using the same request shapes as CloudKit JS (`records/query`,
`records/lookup`, `records/modify`, `changes/zone`, with a `syncToken` /
`moreComing` incremental-sync model). This tool talks to that same service
directly, with its own typed client.

**Auth** is the one piece deliberately *not* reverse-engineered: `clone`
opens a real, headed Playwright browser window on Apple's own sign-in
pages, and once the page's own bootstrap call succeeds, session cookies are
harvested from the browser and the window closes. This keeps the
reverse-engineered surface limited to the *result* of login (a cookie jar
and client identifiers), not Apple's login protocol itself, which churns
far more (their current web client requires a device-attested 2FA flow that
plain HTTP can't replicate).

**Note content** lives in fields named things like `TitleEncrypted` and
`TextDataEncrypted`. Despite the name, on accounts *without* Advanced Data
Protection, these arrive as plain, readable bytes (compressed, not
encrypted client-side — `ENCRYPTED_BYTES` here describes Apple's
server-side at-rest encryption, not end-to-end encryption). Decompressing
them yields the same internal format Notes uses on-device in
`NoteStore.sqlite`, which this project's own `.proto` schemas (in `proto/`)
target — cross-checked against Apple's own recovered source and against
several other independent reverse-engineering efforts of the same format.

**Writing a note back** isn't a simple overwrite. `push` fetches the note's
current version from the server, verifies it can rebuild that exact
version byte-for-byte from what this tool understands, applies just the
local edit, re-verifies the result matches the local file exactly, and
only then uploads. Anything this tool doesn't fully understand stays
read-only rather than risk a bad write. `push --dry-run` runs every step
except the final upload; table edits go through an analogous check.

## Non-goals

- Real-time/continuous sync.
- Full replication of Notes' own internal merge behavior for concurrent
  edits from other Apple devices — `pull` does a real line-level three-way
  text merge instead.
- Perfect fidelity for rich formatting, scanned documents, or drawings.
- Attachment upload.
- Deleting or moving/renaming notes shared with you (see Known
  limitations for exactly what's refused — creating and editing shared
  notes *is* supported).

## Reporting bugs

Every reported issue must include three things:

- A bug report export
- Reproduction steps
- File Identities

For each of these, read more below.

> [!WARNING]
> It is strongly recommended that, instead of submitting
> bug reports for actual notes you need day-to-day, that
> you instead create a test note specifically for reproducing
> whatever bug and generating a bug report. Owing to how
> notes work, we must know the content of the note you are
> submitting a report for!

### Getting a Bug Report Export

Run

```
icloud-md bug-report --since <duration>
```

(e.g. `--since 10m`, run against the affected directory).

This will generate a markdown document outlining the state
of your note clone as well as any recent log messages.

> [!WARNING]
> The bug report intends to remove the most dangerous of PII
> (e.g. your apple ID, name, email, and internal IDs like
> your dsid), but it **does not redact the underlying content
> of a note or table touched by a recent `push`/`pull`/`diff`/`revert`**.
>
> Users reviewing your report can at least:
> - See the content you changed in any notes you changed during
>   the time window you selected your bug report to span.
> - See the content of any attachments (via a signed URL) in those notes.
> - Possibly other things, too!
>
> As part of the bug report creation process, we create a file
> of the same name but with a `content-preview.md` extension.
> That file will include decompressed versions of the logged
> information above so you can have a better understanding
> of what content can be decoded from the bug report you may
> choose to submit.
>
> If you have recently cloned your repository, that export
> might expose the full content of every single file in
> your notes! It is recommended that you instead reproduce
> whatever problem in isolation (a few minutes after
> doing anything else with your icloud notes on any device)
> and then narrowly generate a bug report for just the range
> of time during which your problem occurred.
>
> **Be careful to review the `content-preview.md` file created
> alongside your bug report to ensure that you are not leaking
> private information!**

### Reproduction Steps

Reproduction steps must be precise, concrete, and scriptable,
and must describe both every step you took as well as what problem
you encountered (including the exact error message or stack trace
you received if you received one) and what you expected to take
place instead of the error you received, even when you think
what should be expected is obvious.

For example:

> - I cloned my repository.
> - The file originally looked like X
> - I modified it to look like Y
> - When I tried to push, the push was rejected and I received this error message: "PUSH REJECTED: 404"
> - What I expected was that the note would be pushed successfully.

Where X and Y are two files you've attached as part of your
bug report.

### File Identities

The bug report export above intentionally does not include the names
of any files in your notes. To find relevant log entries, you will need
to get the bug report identity for any relevant files; to do that, you can run:

```
icloud-md bug-report --identify FILENAME
```

identities for each file you discuss in your reproduction steps must be included
for any report to be accepted.

For example:

> "./My Note.md" is note-72 in this vault's bug reports.


## Contributing / development

```
npm install
npm run typecheck
npm test
npm run build
```

Issues and PRs welcome — see the disclaimer above for the general spirit of
this project: it's reverse-engineered, and safety-over-completeness is a
deliberate design principle, not an oversight.

## License

MIT
