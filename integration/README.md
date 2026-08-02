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
