# How can I contribute?

Thanks for your interest in contributing! Contributions are welcome, but a bit of coordination up front goes a long way toward ensuring everyone’s time is well spent.

## Start with a Discussion

Before opening a pull request—especially for **new features or behavioral changes**—please start a discussion first:

👉 [https://github.com/coddingtonbear/icloud-md/discussions](https://github.com/coddingtonbear/icloud-md/discussions)

This helps confirm that the idea aligns with the project’s direction and avoids contributors investing time in changes that ultimately won’t be merged.

## Contribution Expectations

### Project Direction & Scope

- Contributions are evaluated based on **alignment with the project’s design goals and philosophy**, not just correctness.
- Bug fixes are generally easier to accept than new features.
- Not all well-implemented contributions are guaranteed to be merged.
- **Safety over completeness is the deliberate design principle here, not an oversight.** This tool works by reverse-engineering an undocumented CloudKit API and Apple's own on-disk note format—see "How it works" in the README. Where this tool doesn't fully understand a note's content or format, the existing code refuses to write it back rather than guessing. A contribution that makes `push`/`delete`/`revert` more permissive by relaxing one of these refusals, without first proving (ideally via a real captured/`--dry-run`-verified round trip) that the case is actually safe, is unlikely to be accepted even if it "fixes" a refusal someone found annoying.
- Changes to the wire format handling (`proto/`, anything touching CloudKit request/response shapes) should be grounded in a real capture, not guesswork—see `har_captures/README.md` for the capture convention this project uses when reverse-engineering new behavior.

### Tests & Documentation

All contributions that modify behavior or add features are expected to:

- Update or add tests covering the new behavior
- Update documentation (README and/or code comments) to describe the change or new functionality

Changes without corresponding tests or documentation are unlikely to be accepted.

### Verifying Your Change

Before opening a pull request, run:

```
npm install
npm run typecheck
npm test
npm run build
```

All four should pass cleanly. If your change touches the `.proto` schemas, also run `npm run proto:generate` and `npm run proto:check` to confirm the generated code isn't out of sync.

### Scope & Quality

- Pull requests should remain **narrowly scoped** to the problem they intend to solve.
- Unrelated refactors, cleanup, or stylistic changes should be avoided unless discussed beforehand.
- CI failures or linting issues should be resolved before review.

### Ownership & Follow-Through

- Contributors are expected to **actively shepherd their pull requests**, including responding to feedback and making requested changes.
- Maintainers may make small edits, but won’t complete large reworks on a contributor’s behalf.
- Pull requests that see **no forward progress for 90 days** may be closed due to inactivity.

## Communication & Conduct

- Please communicate respectfully and patiently.
- Maintainers work on this project in their limited free time; demands for timelines or merges are discouraged.
- Questions, suggestions, and constructive disagreement are welcome—but entitlement or pressure is not.
