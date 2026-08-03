# Live integration suite

End-to-end tests against a **real iCloud account**: real clones, real pushes
and pulls, checked against both an independent second clone and what Apple's
own web client actually shows.

These tests perform real writes. They are off unless `ICLOUD_MD_ITEST=1`, so
`npm test` stays hermetic and offline.

## Why two oracles

A test that only compares one clone against another has a blind spot: a bug
where this tool encodes something wrongly and then decodes its own wrongness
back reads as a pass. So every push is also checked against the iCloud web UI
via Playwright — an observer entirely outside this project's own code.

The cheap check (a second clone) carries the routine load; the web oracle is
used at the points that matter, since a web read costs 15–20 seconds.

## How the web oracle works

Worth knowing before changing `webOracle.ts`, because none of it is obvious:

- icloud.com/notes runs inside an iframe served from `/applications/notes3/…`.
  Everything must be queried through that frame.
- A note is addressable directly at
  `/notes/note/<base64("Private::Notes::currentUser::<UUID>")>`, so the oracle
  jumps straight to a record id instead of scraping the sidebar.
- **The note body is rendered to a `<canvas>`.** It is not in the DOM, and the
  accessibility tree does not mirror it. There is nothing to scrape.
- The way in is the clipboard: focus the editor, select all, copy. Apple's own
  client then serialises the note as `text/plain` *and* as a `text/html` whose
  every span carries a `data-tt` attribute holding Apple's native paragraph
  style enum. That is what lets the oracle assert formatting, not just text.
- The oracle never types into a note. The only keys it sends are select-all
  and copy.

It decodes the style enum with its own copy of the mapping rather than
importing `noteFormat.ts`'s — if it shared ours, a wrong mapping would cancel
itself out and the test would pass anyway.

## Negative controls

Two of the merge tests are a matched pair. One pushes a correctly restamped
deletion and proves an open client *adopts* it; the other pushes the same
deletion with the tombstones left at their original style timestamp and proves
the client *discards* it. Same edit, opposite outcomes, the clock discipline
being the only difference — which is what makes the first test evidence about
our restamping rather than about deletions in general.

The wrong shape cannot be produced through the normal write path (`applyTextEdit`
always restamps), so `tiedAnchorDeletion.ts` builds it by letting the production
codec do the correct edit and then reverting only the stamps, and writes it back
through the ordinary `records/modify` call. That file is test-only on purpose:
nothing in `src/` should be able to author a document that loses a merge.

`tiedAnchorDeletion.test.ts` covers it offline, on captured bytes, and runs under
plain `npm test` — a helper that silently emitted a *correct* deletion, or a
malformed one, would make the live test pass for the wrong reason.

## Tables

`push` can only *edit* a table that already exists, and the oracle never
types, so for a long time nothing in the harness could put a table in front of
a test — leaving the one write path with two live corruption incidents behind
it with no live coverage at all.

`plantTable.ts` closes that by planting one. The obvious objection is that a
fixture we author with our own codec and read back with our own codec proves
nothing, so none of it is ours:

- the table document is a **real captured `MergeableDataEncrypted` payload**
  (`realFixtures.ts`'s `TABLE_REV_BASELINE`), copied through untouched;
- the `Attachment` record's field set is **Apple's own create**, from entry 39
  of the 2026-07-16 note-lifecycle capture;
- the only part this project authors is the U+FFFC wiring in the note body, and
  the suite asserts nothing about any *edit* until Apple's client has rendered
  the planted table with the cells it should have.

Reading the result back needed a different route from the rest of the oracle.
A table is not on the clipboard — it copies as the bare U+FFFC placeholder,
marked `data-tt-replacement="true"`, with none of its cells — and it is not in
the DOM either, being canvas-rendered like the body. So the oracle reads
`icTableManager` instead: the sibling of the `topoTextManager` whose merge
traces the suite already uses, holding the live `CRTable` the client decoded
from the attachment's bytes, keyed by attachment record id. Walking its
`_rows`/`_columns` and reading each cell's `.string.UTF16String` is Apple's own
view of the grid, from Apple's own decoder.

That is a stronger second opinion than scraped markup would have been: it needs
no merge to have happened and no UI to be driven, and it is keyed by attachment
id, so an LRU still holding a table from an earlier note can't be mistaken for
this one.

`plantTable.test.ts` covers the planter offline, on captured bytes, under plain
`npm test`: a planter that quietly produced a malformed body would make the
live tests fail for a reason unrelated to the write path.

## Containment

Fixtures are confined to a dedicated Notes folder, and two independent keys
must both turn before anything is deleted:

1. the record is inside that folder, **and**
2. either it appeared during this run, or its title carries this run's
   `(itest-<runId>)` prefix.

A prefix-only rule would let a mistyped folder name delete something else in
the account; a folder-only rule ("empty the folder") would delete anything a
human filed there. The suite also refuses to start if the folder holds a note
without a fixture prefix.

The suite never creates or deletes the folder itself. `push` cannot create
folders at all, which is a useful accident: the suite is structurally unable
to invent a container outside the sanctioned one.

Those two keys turn on notes and folders — everything `push` can make. A test
that reaches CloudKit directly can create records the walk doesn't see (the
table fixture's `Attachment` record is the only one today), so it registers
them with `RunContext.disposeAfterTeardown`, which removes them once teardown
has taken the notes referencing them.

Note the prefix uses parentheses, not square brackets: `[` and `]` are
homoglyph-substituted on the way into a file name, so a bracketed prefix would
collide with the very projection under test.

## Setup

One-time, and only once per machine:

```bash
# 1. Sign in, if you haven't already
icloud-md clone ~/some-vault

# 2. Create the containment folder (or make it by hand in Apple Notes)
ICLOUD_MD_ITEST_DSID=<dsid> npm run itest:setup
```

Find your dsid under `~/.config/icloud-md/accounts/`. If exactly one account
is signed in, `ICLOUD_MD_ITEST_DSID` can be omitted everywhere.

## Running

```bash
ICLOUD_MD_ITEST=1 npm run test:integration
```

A full run takes roughly three minutes and prints the account, folder and run
id before touching anything.

Clones happen unattended thanks to `clone --account <appleId|dsid>`, which
reuses that account's already-trusted browser profile. If the saved sign-in
has lapsed, it falls back to a visible browser window so you can complete it.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `ICLOUD_MD_ITEST=1` | Required. Enables the suite. |
| `ICLOUD_MD_ITEST_DSID` | Which account to use. Optional when only one is signed in. |
| `ICLOUD_MD_ITEST_FOLDER` | Containment folder name (default `icloud-md-itest`). |
| `ICLOUD_MD_ITEST_WORKROOT` | Where clones are made (default a tmpdir). |
| `ICLOUD_MD_ITEST_HEADED=1` | Show the oracle's browser window. |
| `ICLOUD_MD_ITEST_KEEP=1` | Keep clone directories after the run, for debugging. |

## When a run leaves debris

A run killed partway through can leave fixtures behind, and an untitled
leftover will block later runs at the guard. Clear the folder with:

```bash
ICLOUD_MD_ITEST=1 npm run itest:sweep
```
