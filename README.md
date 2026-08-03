Apple Notes only lives one place: Notes.app or the iCloud web client. There
is no export, API, or any easy way to read or edit your own notes from anywhere else.
`icloud-md` frees them from icloud by turning your Apple Notes into a folder
of real Markdown files, on Linux, Windows, or macOS, editable in whatever tool
you already use (Vim, VS Code, Obsidian, `grep`) and syncs your edits
back to iCloud as if you'd typed them into Notes.app all along.

```bash
# First, clone your notes somewhere
icloud-md clone ./my-notes
# Then make some changes to one of those notes
cd my-notes && $EDITOR "Grocery list.md"
# Finally, push them up to iCloud
icloud-md push
```

<!-- toc -->

- [Why](#why)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [What works today](#what-works-today)
- [Where the title lives](#where-the-title-lives)
  * [`--defer-renames`](#--defer-renames)
- [Known limitations](#known-limitations)
- [How it works](#how-it-works)
- [Non-goals](#non-goals)
- [Comparison with other projects](#comparison-with-other-projects)
  * [Platform & direction](#platform--direction)
  * [Fidelity & content types (read / write)](#fidelity--content-types-read--write)
- [Reporting bugs](#reporting-bugs)
  * [Getting a Bug Report Export](#getting-a-bug-report-export)
  * [Reproduction Steps](#reproduction-steps)
  * [File Identities](#file-identities)
- [Contributing / development](#contributing--development)
- [License](#license)

<!-- tocstop -->

## Why

- **Your notes become real files** — one Markdown file per note, editable,
  versionable in git, greppable, diffable, scriptable — instead of locked
  inside Notes.app or the iCloud web client.
- **Every OS, not just Apple's**: `icloud-md` is a plain Node CLI. Clone
  your notes to Linux or Windows and treat them like any other folder of
  text, no Mac required.
- **Actually bidirectional, not just export**: `pull` and `push` keep your
  local folder and iCloud in sync in both directions — edit locally, edit
  in Notes.app, or edit from another device, and it reconciles.
- **Built-in version history**: Every `pull`/`push` that
  changes a note snapshots it, so you can inspect or roll back *any* past
  version of a note.
- **Conflict-awareness**: If a note changed in iCloud
  since your last sync *and* you edited it locally, `pull` does a real
  three-way merge and only asks you to resolve the parts that actually
  overlap — the rest merges automatically.
- **`git`-flavored CLI**: You're probably already familiar with what the
  various `git` commands do; that knowledge is most of what you need to
  know to use this tool.

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

```bash
npm install -g icloud-md
```

This puts the `icloud-md` command on your `PATH`.

Building from a clone of this repo instead:

```bash
git clone https://github.com/coddingtonbear/icloud-md.git
cd icloud-md
npm install
npm run build && npm link
```

(Re-run `npm run build` after pulling source changes.)

## Quick start

```bash
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

If you keep your notes in Obsidian (or any editor where the file name *is*
the document title), clone with `--filename-as-title` instead:

```bash
icloud-md clone ./my-notes --filename-as-title
```

Each file is then named for its note's title and contains only the body,
rather than repeating the title as the first line. See
[Where the title lives](#where-the-title-lives) for what that changes.

After that:

```bash
cd my-notes
icloud-md status        # what would `push` do right now?
icloud-md pull          # fetch remote changes, merging with local edits
icloud-md push          # send local changes back to iCloud
```

If you keep several vaults for the same Apple ID, name the account to skip
the sign-in window entirely — `clone` then reuses that account's saved
sign-in, and normally completes with no interaction at all:

```bash
icloud-md clone ./another-vault --account you@example.com
```

Without it, `clone` always asks: a new directory has no account yet, and
reusing a saved sign-in *silently* would let iCloud's own cookies decide
which account you got. Naming it removes the ambiguity — and if the completed
sign-in turns out to be a different Apple ID, the clone fails rather than
binding to the wrong one.

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
| `clone <directory> [--filename-as-title] [--account <appleId>] [--non-interactive]` | Full initial export into a fresh directory: every note, attachments included. Signs in via a browser window the first time a directory (or Apple ID) is used. Refuses to run against an already-cloned directory — use `pull` there instead. `--filename-as-title` picks the Obsidian-shaped layout for the vault; it can only be chosen here. `--account` clones as an Apple ID already signed in on this machine, reusing its saved sign-in instead of asking. `--non-interactive` never opens a sign-in window, failing instead — for unattended runs, where a window has nobody to complete it. |
| `pull [directory] [--defer-renames]` | Fetch everything that changed remotely since the last sync; auto-merges non-overlapping local edits, writes conflict markers for overlapping ones. Defaults to the current directory. `--defer-renames` is for editor integrations in a filename-as-title vault — see [Where the title lives](#where-the-title-lives). |
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
  A directory the account doesn't have yet becomes a real Notes folder,
  nesting included — `mkdir Recipes/Desserts`, drop a note in, and `push`
  creates both folders ahead of the note.
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
- **Obsidian notation survives the trip.** Wikilinks and embeds
  (`[[Note]]`, `[[Note|alias]]`, `![[img.png|300]]`), callouts
  (`> [!NOTE] Title`), tags (`#project`), highlights (`==like this==`), and
  footnotes (`[^1]`) keep their notation in the local file instead of
  picking up the backslashes plain CommonMark would want
  (`\[\[Note]]`, `\#project`). Markup that really *is* markdown — a `#`
  heading, `[a](b)`, a `---` rule — still gets escaped, and every note is
  re-parsed before the friendlier spelling is kept, so it can never cost
  fidelity. Inside a table cell an alias pipe is written `[[Note\|alias]]`,
  the form Obsidian itself requires there.
- **Ordinary words keep their punctuation.** Because GFM turns `www.…`,
  `https://…` and `name@host` into links on sight, plain CommonMark escapes
  the punctuation that *might* start one — anywhere, in any word. That gave
  files `flow\.ts`, `window\.open()`, `me\@example.com`, and (the case that
  prompted the fix) `Www\.VJW\.digital.go.jp`. Those are written as typed
  now, under the same re-parse check as everything above.
- **Local-only YAML frontmatter.** A leading `---` frontmatter block (for
  Obsidian tags, aliases, and the like) is treated as local metadata: it's
  skipped when deriving the note's title (the title is the first line *after*
  the frontmatter) and preserved across `pull`/`push`, so editing it never
  looks like a note change. See Known limitations for the catch.
- **Two vault shapes.** A vault carries note titles either in each file's
  first line (the default) or in its file name (`clone
  --filename-as-title`, for Obsidian and friends). See
  [Where the title lives](#where-the-title-lives).
- **`delete`/`delete --hard`**, and the `object` repair-kit commands, for
  cleaning up notes this tool (or anything else) leaves in a broken state.
- **`history`/`diff`/`revert`**, and push-time auto-merge via version
  history — the safety net for inspecting or undoing a bad edit.

## Where the title lives

An Apple note has no title field of its own worth the name — its title *is*
its first line. That leaves two honest ways to put a note in a file, and a
vault picks one at `clone` time:

| | Default (`in-body`) | `--filename-as-title` |
| --- | --- | --- |
| The file contains | the title as its first line, then the body | the body only |
| The file is named | after the title, as a convenience | after the title, because that *is* the title |
| Retitling a note | edit the first line | rename the file, or set `apple-note-title` |
| Suits | plain Markdown, git, anything that reads a file top to bottom | Obsidian and friends, where the file name is the document title |

Both shapes record each note's identity in local-only
`apple-note-id` frontmatter, which is what makes a rename resolvable at all:
in filename-as-title mode a rename *is* a retitle, and `push` sends it as
one rather than seeing an unrelated new note.

A few consequences worth knowing before you pick:

- **A file name can hold more than you'd think.** Characters a file name
  can't contain (`/`, `:`, `?`, …) are substituted with visually-near
  Unicode look-alikes and substituted back on the way up, so a note titled
  `Pat/Alex: notes` keeps its real title on the round trip. The rare title
  no name can carry at all (extremely long, leading dot, a reserved name
  like `CON`) is filed as `Untitled.md` with the real title recorded in
  `apple-note-title` frontmatter, and `pull` says so on the changelist line.
- **`apple-note-title` also works in the other direction.** Setting it on a
  note asks for that title, which is the only way to give a note a title no
  file name could spell. `push` sends the retitle; the file itself is
  renamed on the next `pull`, which then drops the key again if the new
  title turns out to be one a name can carry after all.
- **A note retitled on your phone gets its file renamed on the next
  `pull`**, since there is nowhere else for the new title to go. A retitle
  you asked for locally takes the same road, which is why renaming is always
  something `pull` does and never something `push` does.
- **The mode is chosen once.** Switching an existing vault between the two
  shapes isn't supported yet: it would have to rewrite every file in the
  vault, which is a different (and more dangerous) operation than the
  version migrations `pull`/`push` run for you. Clone a fresh vault instead.

### `--defer-renames`

A rename this tool performs happens behind your editor's back, so an
Obsidian vault's `[[wikilinks]]` to a remotely-retitled note go stale.
`pull --defer-renames` exists for integrations that can do better: pull
reports the rename it *would* have performed and leaves the file alone, and
the integration performs it with link updating turned on.

The rename is reported as a `pendingRename` path on the note's entry in
`pull --json`'s change list, and again on `status` (`rename: Old.md ->
New.md`) for as long as it's outstanding — so an integration that restarted
can still find out what it owes. Nothing else stalls in the meantime: the
note's content keeps syncing in both directions, because a tracked note's
title always comes from the live record rather than from its file name. A
plain `pull` performs any rename left undone, which is the way out if the
integration never gets to it.

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
- **Folders are only ever created, never renamed or deleted remotely.**
  A new local directory becomes a Notes folder, but renaming a directory
  reads as a *new* folder plus a batch of note moves — the folder it left
  behind stays in Notes, empty — and deleting a directory leaves its folder
  in place. A directory carries no id the way a note does (`apple-note-id`
  lives in a note's frontmatter, and a folder has nowhere to put one), so a
  rename can't be told apart from a delete-plus-create. Renaming and
  deleting folders in Notes itself works fine and syncs down normally.
- **New folders are only created in your own Notes.** A directory inside
  someone else's shared area is refused: the folder would have to be created
  in their zone, under their share.
- **Frontmatter never leaves your machine.** Apple Notes has nowhere to
  store a YAML frontmatter block, so it's kept purely local — never uploaded,
  and never visible on your other devices. It survives `pull`/`push` because
  this tool reattaches it locally, not because iCloud knows about it.
- **A vault's title mode can't be changed after `clone`.** Switching
  between the two shapes would rewrite every file in the vault; clone a
  fresh one with the mode you want instead.
- **File arguments resolve by path, not by note.** `restore`, `delete`,
  `diff`, `history` and `revert` look a `<file>` up by where it was at the
  last sync, so a file you renamed since then is reported as untracked
  until you `push` the rename. Use the old name, or push first. (`push`
  and `status` themselves are fine — they pair a renamed file back to its
  note by its `apple-note-id`.)
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

## Comparison with other projects

Several other projects read or write Apple Notes. Most fall into two camps:
tools that drive a live `Notes.app` on macOS (so they can't run anywhere
else), and read-only parsers of the on-device `NoteStore.sqlite` database.
`icloud-md` is the only one that talks to iCloud directly from any OS *and*
syncs edits back.

Legend: ✅ yes · ⚠️ partial / with caveats · ❌ no · — not applicable ·
❓ unverified. In the content table, cells are marked **read / write**.

### Platform & direction

| | icloud-md | [Notes-Of-Fruit](https://github.com/ericmigi/Notes-Of-Fruit) | [macnotesapp](https://github.com/RhetTbull/macnotesapp) | [memo](https://github.com/antoniorodr/memo) | [notesutils](https://github.com/dunhamsteve/notesutils) | [apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser) | [apple-notes-parser](https://github.com/RhetTbull/apple-notes-parser) |
|---|---|---|---|---|---|---|---|
| Usable outside a Mac | ✅ | ✅ (Android) | ❌ | ❌ | ⚠️¹ | ⚠️¹ | ⚠️¹ |
| Language | TypeScript / Node | Kotlin | Python | Python | Python | Ruby | Python |
| Data source | CloudKit | CloudKit | live Notes.app | live Notes.app | local SQLite | local SQLite | local SQLite |
| Reads notes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Writes notes | ✅ | ⚠️ legacy only | ✅ | ✅ | ❌ | ❌ | ❌ |
| Reconciling sync² | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### Fidelity & content types (read / write)

| | icloud-md | [Notes-Of-Fruit](https://github.com/ericmigi/Notes-Of-Fruit) | [macnotesapp](https://github.com/RhetTbull/macnotesapp) | [memo](https://github.com/antoniorodr/memo) | [notesutils](https://github.com/dunhamsteve/notesutils) | [apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser) | [apple-notes-parser](https://github.com/RhetTbull/apple-notes-parser) |
|---|---|---|---|---|---|---|---|
| Decodes note format | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ |
| Surgical writes | ✅ | ✅ | ❌ | ❌ | — | — | — |
| Rich text | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ⚠️ | ✅ / ❌ | ✅ / ❌ | ⚠️ / ❌ |
| Tables | ✅ / ✅ | ✅ / ❌ | ⚠️ / ⚠️ | ⚠️ / ❌ | ✅ / ❌ | ✅ / ❌ | ❓ / ❌ |
| Checklists | ✅ / ✅ | ✅ / ❌ | ❌ / ❌ | ❌ / ❌ | ✅ / ❌ | ✅ / ❌ | ❓ / ❌ |
| Attachments | ✅ / ❌ | ✅ / ❌ | ✅ / ✅ | ⚠️ / ⚠️ | ✅ / ❌ | ✅ / ❌ | ✅ / ❌ |
| Folders | ✅ / ✅ | ❓ | ✅ / ✅ | ✅ / ⚠️ | ❌ / ❌ | ✅ / ❌ | ✅ / ❌ |
| Markdown | ✅ native | ❌ | ⚠️ generic | ⚠️ generic | ⚠️ | ❌ | ❌ |

¹ Runs on any OS, but only parses a `NoteStore.sqlite` database that must
first be copied off an Apple device — so not really Mac-free in practice.

² Others can read and write individual notes, but only `icloud-md`
reconciles changes made on both sides.

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

```bash
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

```bash
icloud-md bug-report --identify FILENAME
```

identities for each file you discuss in your reproduction steps must be included
for any report to be accepted.

For example:

> "./My Note.md" is note-72 in this vault's bug reports.


## Contributing / development

```bash
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
