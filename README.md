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
*not* reimplemented: `login` opens a real (headed) browser window via
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

Phase 0 is mostly done. `npm run cli -- login` opens a browser window on
`www.icloud.com`, waits for you to complete sign-in there (any 2FA variant
works — Apple's own pages are doing the work), then captures the session
cookies, verifies them against `/validate`, writes
`~/.config/icloud-notes-sync/session.local.json`, and closes the window.
The session (and a request/response debug log - see below) is shared across
every vault, not scoped to whichever directory the CLI happens to be
invoked from: `login` once, then any number of `clone`/`pull` targets reuse
the same session. This only supports one Apple ID at a time:

1. One-time setup: `npx playwright install chromium` (the login browser;
   a one-off ~150 MB download).
2. `npm run cli -- login` opens the browser window; sign in as you normally
   would. The command detects completion on its own, verifies the captured
   session, and closes the window. Closing the window yourself aborts.
3. The login browser keeps a persistent profile under
   `~/.config/icloud-notes-sync/browser-profile/`, so after the first
   sign-in Apple treats it as a trusted, returning browser — later `login`
   runs typically skip 2FA (and may need no interaction at all if the
   profile's own session is still alive).
4. `npm run cli -- verify-auth` calls the same `/setup/ws/1/validate`
   endpoint the web client calls on page load, using that session. Success
   confirms the session is valid and prints the account's `dsid` and the
   partition-specific CloudKit host (e.g. `p43-ckdatabasews.icloud.com`)
   that all Notes calls need.

One fallback bootstrap path also exists: `npm run import-har --
<path-to-file.har>` extracts cookies from a Chrome DevTools export, mainly
for debugging against a known-good browser session. (For headless
environments, run `login` on a machine with a display and copy
`session.local.json` over — the session file is host-independent.)

`npm run cli -- clone <directory>` is implemented: it walks the whole Notes
zone, decodes plain-text note bodies, and writes one file per note into the
target directory, skipping notes with attachments, notes in Trash, and
anything that fails to decode. It also writes `.icloud-notes-sync/state.json`
(per-note record name → file/changeTag/modification date, plus the zone's
syncToken) and a pristine "base copy" of each note's text under
`.icloud-notes-sync/base/` - the merge ancestor `pull` needs for real 3-way
merging.

`npm run cli -- pull [directory]` (defaults to the current directory) is also
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

**A note on session lifetime:** a HAR-imported session's short lifespan was
caused by racing a *browser tab's* own background heartbeat — the tab calls
`/setup/ws/1/validate` every 14 minutes and rotates the session's bearer
token (`X-APPLE-WEBAUTH-TOKEN`) each time, invalidating whatever value was
snapshotted into the HAR. A session minted by `login` isn't shared with any
browser tab, so it isn't racing against that heartbeat. Whether it can still
go stale from long idle periods independent of that heartbeat is still an
open question (see the project's dev notes) — this tool doesn't yet drive
its own periodic `/validate` refresh, so if `verify-auth` ever reports a
stale session, re-running `login` (fast, since the persistent browser
profile usually skips 2FA) is the fallback.

## Commands

Deliberately reusing git's own vocabulary rather than inventing new terms,
since the tool is explicitly modeled on git's fetch/push workflow and these
words are already the most discoverable choice for what each one does:

- **`login`** *(implemented)* — sign in via a browser window (Apple's own
  pages handle password/2FA) and write
  `~/.config/icloud-notes-sync/session.local.json`, shared by every vault.
  Not git vocabulary, but there's no `git` equivalent to steal a name from
  here.
- **`clone <directory>`** *(implemented)* — full initial export: fetch every
  note and write it into a fresh directory, alongside sync state.
- **`pull [directory]`** *(implemented)* — run inside (or pointed at) a
  cloned directory; fetches whatever changed remotely since the last sync
  (using the stored `syncToken`) and updates local files accordingly, or
  reports a conflict instead of overwriting a note that also changed
  locally. Named `pull`, not `fetch`, because there's no separate
  remote-tracking ref to update first — it goes straight to the working
  directory, same as `git pull` without a merge step.
- **`push`** *(not yet implemented)* — send local edits back up. Refuses to
  push a note whose remote `recordChangeTag` has moved since the last
  `clone`/`pull` baseline, surfacing that as a conflict instead of
  overwriting newer remote content — the safety mechanism this needs isn't a
  full merge, just "don't clobber a change you haven't seen."

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
files in a folder (git repo). Notes with attachments, or with any structure
we can't confidently decode, are skipped/reported rather than partially
synced. Store enough metadata per note (record name, change tag,
modification date) to support later phases.

**Phase 2 — Change detection.** On each fetch, compare each note's stored
baseline (change tag / modification date) against both the current remote
state and the local file's state, to answer "did this change locally,
remotely, both, or neither?" This is groundwork for conflict handling, not
full merge logic yet.

**Phase 3 — Write-back for plain-text notes.** Build the note protobuf back
up from an edited local file and push it via `records/modify` (`update`,
with `recordChangeTag` for optimistic concurrency). Restricted to notes we
can prove round-trip cleanly: decode → re-encode → byte-for-byte match
against the original (modulo the intended edit) before we ever consider
writing to a note. Anything we can't verify this way stays read-only.

**Phase 4 — Attachments.** Download attachments (served from a separate
signed-URL asset host, `cvws.icloud-content.com`) and represent them
locally. Upload/re-reference of new or changed attachments comes after
download-only support is solid.

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
- Shared notes / collaboration features — private notes only until the core
  sync loop is solid.

## Caveats

- This relies entirely on an undocumented, private API that Apple can change
  without notice.
- It very likely depends on **Advanced Data Protection being disabled** for
  the account in question; ADP may change how (or whether) note content can
  be read this way at all.
- Treat this as a personal tool for your own account, not something to be
  pointed at arbitrary Apple IDs.
