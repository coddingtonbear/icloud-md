# Working on icloud-md

[CONTRIBUTING.md](CONTRIBUTING.md) covers the day-to-day expectations — scope, tests,
documentation, and the verification commands to run before any change is considered done.
Read it first; this file only adds the things that aren't a contributor's business.

## Cutting a release

Releases are cut from `main` by tagging it. The GitHub release is created for you by
[.github/workflows/release.yml](.github/workflows/release.yml) when a `v*` tag is pushed —
**the release notes are the annotated tag's body**, so the notes have to be written before
the tag exists, not after. (A tag with no body falls back to GitHub's auto-generated
commit list, which is not what we want.)

### 1. Pre-flight

Everything intended for the release must already be merged into `main`, and the working
tree must be clean. Then run the full check from CONTRIBUTING.md:

```
npm install
npm run typecheck
npm test
npm run build
```

All four must pass. If the release touches `proto/`, also run `npm run proto:generate` and
`npm run proto:check`. If it touches sync behavior, the live suite
(`ICLOUD_MD_ITEST=1 npm run test:integration`) is worth a run too — it is the only place
the CloudKit round trip is actually exercised.

### 2. Pick the version

Semver, read for a 0.x project: new features or user-visible behavior changes take a minor
bump, pure fixes take a patch. Anything that changes the on-disk vault shape is a minor
bump at least, and needs a migration registered in `src/notes/vaultMigrations.ts` — never a
release that expects the user to re-clone.

### 3. Write the notes

Draft them in a scratch file first; they become the tag body verbatim. The house style,
set by v0.4.0 and v0.5.0:

- A short lead paragraph saying what kind of release this is and what the headline is.
- Then bolded lead-in bullets — `**New: `clone --account`.**`, `**Fixed: ...**` — each
  explaining *why the change matters to someone using the tool*, not which functions moved.
  The commit bodies are the raw material; they are written to be mined for this.
- Call out behavior changes explicitly, even small ones, and reference the issues a release
  fixes (`Fixes #4`).
- Skip bugs that were introduced and fixed within the same release cycle — no user ever saw
  them.

### 4. Bump, commit, tag

```
npm version X.Y.Z --no-git-tag-version        # package.json + package-lock.json only
git commit -am "Release X.Y.Z"
git tag -a vX.Y.Z -F /path/to/notes.txt       # first line "Release X.Y.Z", blank line, then the notes
```

`--no-git-tag-version` is deliberate: npm's own commit-and-tag would write a bare
`Release X.Y.Z` tag message with no body, which is exactly the case the workflow has to
fall back on.

### 5. Push

```
git push origin main
git push origin vX.Y.Z
```

The workflow re-runs install/build/typecheck/test against the tag and then creates the
release. Confirm it:

```
gh run list --workflow=release.yml --limit 3
gh release view vX.Y.Z
```

To fix the notes after the fact, editing the tag will *not* re-trigger anything — use
`gh release edit vX.Y.Z --notes-file notes.txt`.

### 6. npm publish — Adam runs this, not an agent

The npm account's second factor is a security key (WebAuthn), so `npm publish` fails with
`EOTP` from any non-interactive shell; it needs a real terminal so npm can run its
browser-based auth flow. Agents should stop after step 5 and hand off, saying explicitly
that the version is tagged and released on GitHub but not yet on the registry.

Note the ordering hazard this creates: through 0.3.0 we published to npm *first*, so a
failed publish couldn't leave a dangling public release. Since the release is now automatic
on tag push, the GitHub release necessarily lands first. If a publish then fails
unrecoverably, fix it forward with a patch release rather than deleting the tag.

### 7. Write it up

Add a Development Logs entry to the project's note in Adam's vault
(`projects/software/icloud-md/`, found by its `url` frontmatter) recording what shipped,
the version choice and why, and whether the npm publish actually happened — past release
entries note when it was still outstanding, and that is the useful part.
