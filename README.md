# icloud-notes-sync

A command-line tool for syncing Apple Notes (via iCloud) to a local, git-backed
folder — and back again. Inspired by tools like `git` itself: a single binary,
a working tree, and explicit fetch/push-style commands rather than continuous
background syncing.

This project is based on reverse-engineering the private CloudKit web service
that `www.icloud.com/notes` itself talks to. It is **not** an official or
supported API, and it can break at any time if Apple changes the protocol,
the Notes data format, or account-level encryption settings (see
[Caveats](#caveats) below).

## Goals

- **TypeScript.** Chosen deliberately, not just for the Node ecosystem, but
  because a future goal is to reuse this code inside an Obsidian plugin.
- **git-backed working folder.** Notes are materialized as files in a plain
  folder that can be (and probably should be) a git repo, so history, diffing,
  and conflict resolution can lean on tools you already trust.
- **A single CLI**, `git`-flavored in spirit: something like `notes fetch`,
  `notes status`, `notes push`, rather than a daemon or FUSE filesystem (a
  FUSE filesystem was considered but is out of scope for now — the
  auth/session model doesn't lend itself to always-on background access as
  cleanly as periodic fetch/push does).
- **Conflict awareness.** Because both iCloud and the local folder can change
  independently, the tool needs to detect when a note changed remotely since
  the last fetch *and* changed locally, and surface that as a conflict rather
  than silently picking a winner.
- **Safety over completeness.** It's fine — expected, even — for early phases
  to simply refuse to touch notes it doesn't fully understand (attachments,
  tables, unrecognized embedded objects) rather than risk corrupting them.

## How it works (short version)

The iCloud web client talks directly to CloudKit's private database web
service for the `com.apple.notes` container:

```
https://p<N>-ckdatabasews.icloud.com/database/1/com.apple.notes/production/private/...
```

using the same request shapes as CloudKit JS (`records/query`,
`records/lookup`, `records/modify`, `changes/zone`, with a `syncToken` /
`moreComing` model for incremental sync). Authentication is deliberately
*not* reimplemented: signing in opens a real (headed) browser window via
Playwright, Apple's own pages run the entire sign-in flow — password,
whatever 2FA variant the account uses, CAPTCHAs, interstitials — and once
the page's own `setup.icloud.com` bootstrap call succeeds, the session
cookies are harvested from the browser and the window closes. This keeps
the reverse-engineered surface down to the *result* of login (a cookie jar
plus client identifiers) rather than Apple's login protocol itself, which
they actively churn (their current web client uses a device-attested
`bridge/*` 2FA flow that plain HTTP can't replicate — a direct SRP-6a
login was implemented here and later removed for exactly that reason; see
git history if it's ever worth resurrecting).

Note title and body are stored in fields named things like `TitleEncrypted`
and `TextDataEncrypted`. Despite the name, in accounts *without* Advanced
Data Protection enabled, these arrive over the wire as plain, readable bytes
(compressed, not encrypted client-side) — `ENCRYPTED_BYTES` here describes
Apple's server-side at-rest encryption, not end-to-end/device-locked
encryption. Decompressing them yields the same protobuf "mergeable data"
format used on-device in `NoteStore.sqlite`, which existing open-source
projects (e.g. `apple_cloud_notes_parser`) have already reverse-engineered in
useful detail. The compression container (gzip vs. zlib) varies per record
depending on whichever client last wrote it, not on which endpoint served the
read — decoding has to try both.

## Current status

Phase 0 is mostly done. Authentication is **per-folder, but transparently
so**: credentials are never stored inside a vault directory itself (a vault
is exactly the kind of thing that gets copied/zipped/synced/committed
elsewhere, and most of those paths don't respect `.gitignore`), but the CLI
still behaves as if each folder owns its own login. Every Apple ID this
machine has signed into gets its own subdirectory under
`~/.config/icloud-notes-sync/accounts/<dsid>/` (session, a persistent
Playwright browser profile, and a small non-secret `meta.json`); a cloned
folder's own `.icloud-notes-sync/state.json` records only which account it's
bound to (`{ appleId, dsid }`), never any credential material itself.

1. One-time setup: `npm install -g icloud-notes-sync` puts the `icloud-notes`
   command on your `PATH`. (Working from a clone instead: `npm run build &&
   npm link`, re-run `npm run build` after source changes.)
2. `icloud-notes clone <directory>` on a brand-new directory always opens a
   browser window on `www.icloud.com` first - sign in as you normally would.
   The first run downloads the login browser automatically (a one-off
   ~150 MB Chromium fetch, via `npx playwright install chromium` under the
   hood) before opening it. The command detects sign-in completion on its
   own, verifies the captured session, and closes the window. Closing the
   window yourself aborts. Whichever Apple ID you sign into becomes (or is
   matched against) that folder's bound account - so `clone ./my-notes` and
   `clone ./someone-elses-notes` can freely use different Apple IDs, with no
   flag needed.
3. Each account's login keeps its own persistent browser profile under
   `~/.config/icloud-notes-sync/accounts/<dsid>/browser-profile/`, so after
   the first sign-in for that Apple ID, Apple treats it as a trusted,
   returning browser - later sign-ins for that same account typically skip
   2FA (and may need no interaction at all if the profile's own session is
   still alive). `icloud-notes reauthenticate [directory]` forces a fresh
   sign-in against an already-cloned folder's bound account (defaults to the
   current directory) - useful if silent recovery can't get back in on its
   own. It refuses - rather than silently rebinding the folder - if you sign
   into a different Apple ID than the one that folder was cloned for.
4. `icloud-notes verify-auth [directory]` calls the same
   `/setup/ws/1/validate` endpoint the web client calls on page load, using
   that folder's bound account's session (defaults to the current
   directory). Success confirms the session is valid and prints the
   account's `dsid` and the partition-specific CloudKit host (e.g.
   `p43-ckdatabasews.icloud.com`) that all Notes calls need.

One fallback bootstrap path also exists: `npm run import-har --
<path-to-file.har>` extracts cookies from a Chrome DevTools export, verifies
them, and writes them into that account's own subdirectory the same way a
browser login would - mainly for debugging against a known-good browser
session. (For headless environments, run `clone`/`reauthenticate` on a
machine with a display and copy that account's whole
`~/.config/icloud-notes-sync/accounts/<dsid>/` subdirectory over - it's
host-independent.)

`icloud-notes clone <directory>` is implemented: it walks the whole Notes
zone, decodes plain-text note bodies, downloads any attachments (see
"Attachments" below), and writes one file per note into the target
directory, skipping only notes in Trash and anything that fails to decode
or whose attachments can't be resolved. It also writes
`.icloud-notes-sync/state.json` (per-note record name → file/changeTag/
modification date, plus the zone's syncToken) and a pristine "base copy" of
each note's text under `.icloud-notes-sync/base/` - the merge ancestor
`pull` needs for real 3-way merging.

Notes **shared with you** are cloned too. They live in a different place
than your own notes: CloudKit's *shared* database
(`.../production/shared/...`), in one zone per sharer (`changes/database`
enumerates the zones; each is a "Notes" zone tagged with the sharer's
`ownerRecordName`). One wrinkle: the shared database's `changes/zone`
listing doesn't return note bodies, so any live note that arrives without
`TextDataEncrypted` gets a follow-up `records/lookup` (the same call the
web client makes when you open a shared note). Shared notes are written
into the same directory as your own; `state.json` records which sharer's
zone each one belongs to, plus a per-zone syncToken for incremental `pull`.

`icloud-notes pull [directory]` (defaults to the current directory) is also
implemented: it fetches only what changed since the stored syncToken, and
for any tracked note whose local file no longer matches its base copy, runs
a real 3-way (diff3) merge - base vs. local vs. new remote - via
[node-diff3](https://github.com/bhousel/node-diff3). If local and remote
touched different parts of the note, it merges automatically with no
markers at all. If they touched the same region, it writes standard
git-style diff3 conflict markers (`<<<<<<< local` / `||||||| base` /
`=======` / `>>>>>>> remote`) directly into the file for you to resolve by
hand - most editors (VS Code included) already understand this format. A
note deleted remotely while locally edited gets the same treatment, merged
against an empty remote so the markers show exactly what your local edits
were protecting.

`pull` covers shared notes as well, using the per-zone syncTokens stored in
`state.json`. A shared zone that disappears from the enumeration (its owner
stopped sharing with you, or deleted the notes) is deliberately *not*
treated as a deletion: losing access isn't proof the notes are gone, so the
local files stay in place and are merely untracked (with a warning), unlike
a per-note remote deletion, which does remove a clean local copy.

`icloud-notes push [directory] [--dry-run]` sends local edits back up.
It finds tracked notes whose file no longer matches its base copy, refuses
anything ambiguous (unresolved conflict markers, notes shared by someone
else, emptied files, attachment/asset-backed notes), and uploads the rest
via `records/modify` with the note's `recordChangeTag` as an optimistic
lock — a note that changed remotely since the last `pull` is reported as a
conflict (pull first; it merges), never overwritten, and the server
enforces the same tag check again at write time.

**Attachment notes are permanently read-only, not just "not yet".** They're
tracked (readable, editable-looking files, per the "Attachments" section
below) but `push` will always refuse to write them back — the note's
underlying CRDT structure carries attribute runs this tool only reads
(`note_text`), never fully parses or round-trips, so editing one back would
risk corrupting it. If you edit an attachment-bearing note anyway, `push`
reports which file and why, and names `icloud-notes restore <file>` as the
way to discard that edit and get back to a clean, synced copy — see
`restore` below. `push` also refuses a *plain* note whose text has grown a
hand-typed `attachments/...` link or image embed matching the shape this
tool renders: there's no real uploaded file behind it, so pushing it as
literal text would silently "succeed" while doing something other than
what it looks like.

**Attachments.** `clone`/`pull` download attachments and represent them as
files under an `attachments/` folder alongside your notes, with the note's
text rewritten to reference them (`![name](attachments/name)` for images,
`[name](attachments/name)` otherwise) in place of Apple's `U+FFFC`
placeholder character. The fetch chain, confirmed against both an audio and
an image attachment: a note's decoded body embeds an `attachmentIdentifier`
that is itself the CloudKit `recordName` of a separate `Attachment` record,
which references a `Media` record via a `Media` field, whose `Asset` field
holds the actual signed download URL. `state.json` tracks each downloaded
attachment (keyed by the `Attachment` record's recordName) with the
`Media` record's `Asset.fileChecksum`, so `pull` only re-downloads a file
whose checksum has actually changed. `Attachment` records can carry their
own additional signed asset (`MergeableDataAsset`) - seen populated for an
audio recording (transcript/waveform data) and `null` for a plain image -
which isn't downloaded; only the real file (the `Media` record's `Asset`)
is. Upload is a non-goal, not deferred: the web Notes editor has no
affordance to attach a new file to a note at all, so there's no legitimate
client operation to reverse-engineer the way plain-text push had one.

**Known limitations of the current download support**, live-verified with
`clone` against a real account but not yet exercised for the following:

- **Shared-note attachments are unverified.** The fetch chain uses the
  correct database/zoneID for a shared note's attachments (mirroring how
  shared note text already works), but no shared note with an attachment
  has actually been observed live yet - treat this path as unproven until
  it is.
- **`MergeableDataAsset` (the audio transcript/waveform data) is never
  downloaded**, by design - only the real payload (`Media.Asset`). An
  audio attachment's transcript, if it has one, isn't available locally.
- **Multiple attachments in a single note are untested live.** The
  placeholder-to-attachment-reference matching is positional and written
  to handle any number of attachments, but every real note seen so far has
  had exactly one.

**How push edits a note.** The note body isn't just text — it's a CRDT
document (the same "mergeable data" protobuf Apple's own clients sync),
carrying every insertion ever made, with deleted ranges kept as tombstones,
each attributed to a replica (device) and clock. Overwriting it naively
would corrupt other devices' ability to merge. So push:

1. fetches the note's *current* document from the server,
2. requires it to re-encode **byte-for-byte** from our parsed model (any
   structure we don't fully understand → the note stays read-only) — the
   encoder here is [`@bufbuild/protobuf`](https://github.com/bufbuild/protobuf-es)
   (protobuf-es), generated from this project's own `.proto` schemas
   (`proto/versioned_document.proto`, `proto/topotext.proto`,
   `proto/crdt.proto` — reverse-engineered from real captures, with
   names/shapes aligned to Apple's own schema as recovered from the Notes
   web-app bundle) and configured for proto2
   explicit field presence, not a hand-written byte-exact ordered-token
   encoder as in earlier versions of this tool — validated against real
   captures before the switch (see the dev notes),
3. applies the local file's change as a minimal splice — tombstoning
   removed text and inserting new text under this vault's own stable
   replica id (persisted in `state.json`), the same way the web client's
   own editor does (verified by replaying a captured web-client save and
   reproducing its upload byte-for-byte),
4. decodes the rebuilt document and requires it to yield exactly the local
   file's text, re-checks the CRDT's internal invariants, and only then
   uploads (zlib-compressed, as the write path requires).

`--dry-run` runs every step except the upload. Display metadata
(`TitleEncrypted`, `SnippetEncrypted`) is re-derived from the new text the
way the web client derives it; all other record fields are echoed back
unchanged, mirroring captured web-client update operations. Push covers
*edits to existing notes* only: creating new notes remotely, pushing local
deletions, and writing to shared notes are all still out of scope.

**A note on session lifetime:** a HAR-imported session's short lifespan was
caused by racing a *browser tab's* own background heartbeat — the tab calls
`/setup/ws/1/validate` every 14 minutes and rotates the session's bearer
token (`X-APPLE-WEBAUTH-TOKEN`) each time, invalidating whatever value was
snapshotted into the HAR. A session minted by a real sign-in isn't shared
with any browser tab, so it isn't racing against that heartbeat. Whether it
can still go stale from long idle periods independent of that heartbeat is
still an open question (see the project's dev notes) — this tool doesn't yet
drive its own periodic `/validate` refresh, so if `verify-auth` ever reports
a stale session, `icloud-notes reauthenticate [directory]` (fast, since the
account's persistent browser profile usually skips 2FA) is the fallback.

## Commands

Deliberately reusing git's own vocabulary rather than inventing new terms,
since the tool is explicitly modeled on git's fetch/push workflow and these
words are already the most discoverable choice for what each one does:

- **`clone <directory>`** *(implemented)* — full initial export: fetch every
  note (downloading any attachments alongside them) and write it into a
  fresh directory, alongside sync state. Signs in via a browser window the
  first time a directory (or a new Apple ID) is used - there's no separate
  `login` step. Refuses to run against a directory that's already been
  cloned (same spirit as `git clone` refusing a non-empty destination) -
  use `pull` there instead.
- **`reauthenticate [directory]`** *(implemented)* — force a fresh sign-in
  for an already-cloned directory's bound account (defaults to the current
  directory). Not git vocabulary, but there's no `git` equivalent to steal a
  name from here. Refuses - rather than silently rebinding the folder - if
  the completed sign-in turns out to be for a different Apple ID than the
  one that directory was cloned for.
- **`pull [directory]`** *(implemented)* — run inside (or pointed at) a
  cloned directory; fetches whatever changed remotely since the last sync
  (using the stored `syncToken`) and updates local files accordingly, or
  reports a conflict instead of overwriting a note that also changed
  locally. Named `pull`, not `fetch`, because there's no separate
  remote-tracking ref to update first — it goes straight to the working
  directory, same as `git pull` without a merge step.
- **`push [directory] [--dry-run]`** *(implemented)* — send local edits back
  up. Refuses to push a note whose remote `recordChangeTag` has moved since
  the last `clone`/`pull` baseline, surfacing that as a conflict instead of
  overwriting newer remote content — the safety mechanism this needs isn't a
  full merge, just "don't clobber a change you haven't seen." See "How push
  edits a note" above for the CRDT handling and the byte-for-byte round-trip
  gate.
- **`restore <file> [directory]`** *(implemented)* — discard a tracked
  note's local edits, overwriting it with its base copy (the last-known-
  synced text). Purely local, no network call. Not modeled on a specific
  `git` command, but the same idea as `git restore <path>`. The general
  escape hatch for any note stuck behind a `push` refusal you'd rather
  abandon than resolve — most notably a note with an attachment, which
  `push` will never accept edits to (see above).

No `commit`/`branch`/`merge` equivalents are planned — the working directory
*is* the local state, and conflicts are meant to be resolved by hand (or via
whatever the actual git repo wrapping the folder offers), not by the tool
itself.

## Phased roadmap

**Phase 0 — Foundation.** *(mostly done)* Authentication (browser-driven
login), session/cookie handling, and a thin typed client for the CloudKit
private database web service. No note logic yet, just "can we reliably
make authenticated requests." Remaining: a self-driven `/validate` refresh
heartbeat for long-running sessions.

**Phase 1 — Read-only fetch.** Walk the Notes zone via `changes/zone`,
decode the note protobuf format for title/body text, and write notes out as
files in a folder (git repo). Notes with any structure we can't confidently
decode are skipped/reported rather than partially synced (attachments are
handled, not skipped - see Phase 4). Store enough metadata per note (record
name, change tag, modification date) to support later phases.

**Phase 2 — Change detection.** On each fetch, compare each note's stored
baseline (change tag / modification date) against both the current remote
state and the local file's state, to answer "did this change locally,
remotely, both, or neither?" This is groundwork for conflict handling, not
full merge logic yet.

**Phase 3 — Write-back for plain-text notes.** *(core implemented)* Build
the note protobuf back up from an edited local file and push it via
`records/modify` (`update`, with `recordChangeTag` for optimistic
concurrency). Restricted to notes we can prove round-trip cleanly: decode →
re-encode → byte-for-byte match against the original (modulo the intended
edit) before we ever consider writing to a note. Anything we can't verify
this way stays read-only. Remaining Phase 3 work: creating notes remotely,
pushing local deletions, and broader real-device merge validation
(cross-device concurrent-edit behavior against pushed CRDT structures).

**Phase 4 — Attachments.** *(download implemented)* Download attachments
(served from a separate signed-URL asset host, `cvws.icloud-content.com`)
and represent them locally under `attachments/` - see the "Attachments"
section above for the fetch chain and the local representation. Upload is
a non-goal, not a later step: the web Notes editor has no affordance to
attach a new file to a note at all, so there's no legitimate client
operation to reverse-engineer the way plain-text push had one.

**Phase 5 — Obsidian plugin (future, not committed).** Revisit whether the
sync core can be reused directly inside an Obsidian plugin rather than only
a standalone CLI.

## Non-goals (for now)

- Real-time/continuous sync — this is a deliberate fetch/push tool, not a
  background daemon.
- Full CRDT-level merge of concurrent edits — `pull` does a real line-level
  diff3 merge (auto-merging non-overlapping changes, writing conflict
  markers for overlapping ones), but that's a text-diffing tool, not an
  understanding of Notes' own CRDT structure. Overlapping conflicts are
  surfaced for you to resolve, never auto-resolved.
- Perfect fidelity for rich formatting (tables, scanned documents, drawings)
  — see "safety over completeness" above.
- Collaboration features beyond reading — notes shared with you are cloned
  and pulled (read side), but share management (participants, permissions,
  creating/accepting shares) and writing back to shared notes are out of
  scope; write-back generally is Phase 3, and shared notes will be its last,
  most cautious step if at all.
- Attachment upload — the web Notes editor itself has no way to attach a
  new file to a note, so Phase 4 is download/local-representation only.

## Caveats

- **Apple Notes' own folder structure is deliberately ignored.** Whatever
  folders you've organized notes into inside the Notes app itself (Notes'
  `Folder` records) are flattened away — `clone`/`pull` write every note
  from every one of your Notes folders into one single local directory, with
  no subdirectories mirroring that structure. The `Folder` reference on a
  note record is only consulted to detect Trash (so trashed notes can be
  skipped); it's never used to group output. This is intentional behavior
  today, though mirroring the account's folder tree as nested directories is
  under consideration (see the project's dev notes).
- This relies entirely on an undocumented, private API that Apple can change
  without notice.
- It very likely depends on **Advanced Data Protection being disabled** for
  the account in question; ADP may change how (or whether) note content can
  be read this way at all.
- Treat this as a personal tool for your own account, not something to be
  pointed at arbitrary Apple IDs.
