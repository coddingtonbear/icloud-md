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
`moreComing` model for incremental sync). Authentication is the standard
Apple ID web login flow (SRP + 2FA against `idmsa.apple.com`), the same one
projects like `pyicloud` have already documented.

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

Phase 0 is underway. The full SRP + 2FA login flow isn't implemented yet, but
there's a working feedback loop for everything downstream of login:

1. Export a HAR of an authenticated `www.icloud.com` session from Chrome
   DevTools' Network panel, with **"Allow to generate HAR with sensitive
   data"** enabled (gear icon) — cookies are stripped from HAR exports by
   default, and we need them here.
2. `npm run import-har -- <path-to-file.har>` extracts a session (cookies +
   client identifiers) into `.auth/session.local.json` (gitignored, mode
   `600`). It deliberately takes the Cookie header from a single request —
   the last one in the file with one — rather than merging cookies across
   the whole capture, since a capture can span more than one login session
   and blending tokens across sessions produces an invalid combination.
3. `npm run cli -- verify-auth` calls the same `/setup/ws/1/validate`
   endpoint the web client calls on page load, using that session. Success
   confirms the cookies are valid and prints the account's `dsid` and the
   partition-specific CloudKit host (e.g. `p43-ckdatabasews.icloud.com`)
   that all Notes calls need.

This is enough to build and test the read/write CloudKit client work in
Phases 1–3 against a real account without having to fight the login flow on
every iteration. Real SRP + 2FA login will replace the HAR-import step once
the rest of the pipeline is proven out.

`npm run cli -- clone <directory>` is implemented: it walks the whole Notes
zone, decodes plain-text note bodies, and writes one file per note into the
target directory, skipping notes with attachments, notes in Trash, and
anything that fails to decode. It also writes `.icloud-notes-sync/state.json`
in the target directory (per-note record name → file/changeTag/modification
date, plus the zone's syncToken) as the foundation for `pull`'s incremental
fetch and change detection.

## Commands

Deliberately reusing git's own vocabulary rather than inventing new terms,
since the tool is explicitly modeled on git's fetch/push workflow and these
words are already the most discoverable choice for what each one does:

- **`clone <directory>`** *(implemented)* — full initial export: fetch every
  note and write it into a fresh directory, alongside sync state.
- **`pull`** *(not yet implemented)* — run inside a cloned directory;
  fetches whatever changed remotely since the last sync (using the stored
  `syncToken`) and updates local files accordingly. Named `pull`, not
  `fetch`, because there's no separate remote-tracking ref to update
  first — it goes straight to the working directory, same as `git pull`
  without a merge step.
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

**Phase 0 — Foundation.** Authentication (SRP + 2FA), session/cookie
handling, and a thin typed client for the CloudKit private database web
service. No note logic yet, just "can we reliably make authenticated
requests."

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
- Full CRDT-level merge of concurrent edits — conflicts are surfaced, not
  automatically resolved, at least through the phases above.
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
