# Marketing site starting points

> **Status:** `terminal/` was chosen as the project's site. `.github/workflows/pages.yml` deploys it to GitHub Pages (https://coddingtonbear.github.io/icloud-md/) on pushes to main that touch it. `household/` and `trust/` remain as reference prototypes.

Three prototype landing pages for icloud-md — **inspiration/example material, not production sites**. Each explores a genuinely different positioning, grounded in a survey of landing pages for comparable nerd-oriented tools (obsidian.md, syncthing.net, rclone.org, jrnl.sh, zettlr.com, bear.app, atuin.sh, charm.sh, fzf). Every page is a single self-contained HTML file (no external assets, system font stacks) — open it in a browser, or serve the directory with anything.

Live previews (private Claude artifacts, shareable from each page's menu):

- household: https://claude.ai/code/artifact/31726ef2-a873-4db9-8342-156b892b5843
- terminal: https://claude.ai/code/artifact/62883515-7f0c-424c-a445-d596ebb84754
- trust: https://claude.ai/code/artifact/603a313e-8a00-4409-b9c3-6a66664a2c27

## The three directions

### `household/` — "The Household Bridge"

*Your partner plans in Apple Notes. You live in Markdown. Now you both win.*

Warm, light, story-led. Leads with the shared-notes household scenario (the actual origin story of this tool) and gives "works with notes shared **with** you" its own hero-level beat, since it's the least obvious and most differentiated capability. Split-screen hero shows the same checklist as an Apple note and as Markdown. Safety is framed in household stakes ("it will not eat the grocery list"). FAQ answers the questions a non-technical partner would ask. This page targets an audience no pure developer-tool page reaches — people searching "sync shared apple notes to obsidian."

### `terminal/` — "Notes as files"

*Apple Notes, checked out to `./notes`. And pushed back.*

Committed dark, mono-led identity, modeled on the strongest pattern in the research (atuin.sh): install one-liner with copy button directly in the hero, typed terminal transcript as the demo (the product is invisible infrastructure, so the transcript *is* the screenshot — so it quotes real `icloud-md` output verbatim, and shows no other tool). Data-ownership pitch, feature grid, quickstart with real commands, an Obsidian section pointing at the `obsidian-apple-notes` plugin, comparison table versus AppleScript tools and NoteStore.sqlite parsers.

### `trust/` — "Would rather stop than guess" *(researcher's recommended primary)*

*The sync tool that would rather stop than guess.*

Calm, serif, documentation-toned — the Syncthing insight that plainness itself signals trustworthiness. The research found "privacy-first" is now a genre cliché (Obsidian, Logseq, Standard Notes) while **nobody claims correctness** — which is icloud-md's actual differentiator. So the hero exhibit is a *refusal being caught*: an annotated transcript of `status` declining an unsafe push and `pull` writing conflict markers. The safety model is presented as four concrete rules; the reverse-engineering caveat is embraced as part of the trust pitch rather than buried.

## Research findings worth keeping (2026-08-02)

- Two visual strategies split by category: note *apps* show screenshots/illustrations; sync/CLI tools show text — atuin.sh is the best-executed exception (hero install command + stats instead of screenshots).
- Install-above-the-fold reads as confidence; burying it (syncthing, rclone) reads as passive.
- Trust is built by numbers (atuin's stars/counts) or by plainness (syncthing's flat tone). Until icloud-md has big numbers, plainness is the credible route.
- FAQ-near-the-bottom is the consistent pattern for tools touching something users are anxious about; icloud-md's anxiety point is "will this mangle my notes" and deserves a blunt FAQ everywhere.
- Open source is surfaced as ambient infrastructure (header/footer links), not a hero claim.

A sensible combined future: `trust/` as the primary page with `household/`'s scenario as a prominent mid-page section or secondary landing page, and `terminal/`'s quickstart/comparison folded in further down.
