import { test } from "node:test";
import assert from "node:assert/strict";
import { formatsRoundTripEqual, PLAIN_STYLE, type FormatParagraph, type InlineSpan } from "./noteFormat.js";
import { parseNoteMarkdown } from "./parseNoteMarkdown.js";
import { readsBackFaithfully, renderNoteMarkdown } from "./renderNoteMarkdown.js";

function p(kind: FormatParagraph["kind"], text: string, extra: Partial<FormatParagraph> = {}): FormatParagraph {
  const spans: InlineSpan[] = text.length ? [{ ...PLAIN_STYLE, length: text.length }] : [];
  return { kind, indent: 0, blockQuoteLevel: 0, startNumber: 0, text, spans, start: 0, ...extra };
}

/** Step 2's core invariant, checked per case: `parse(render(model))` must
 * reproduce the exact plain text and the rendered-formatting projection. */
function assertRoundTrips(paragraphs: FormatParagraph[]): string {
  const rendered = renderNoteMarkdown(paragraphs);
  const back = parseNoteMarkdown(rendered);
  assert.equal(back.status, "ok", back.status === "ok" ? undefined : `parse failed: ${back.reason}\nrendered: ${JSON.stringify(rendered)}`);
  if (back.status !== "ok") throw new Error("unreachable");
  assert.equal(back.text, paragraphs.map((x) => x.text).join("\n"), `text drifted through ${JSON.stringify(rendered)}`);
  assert.equal(formatsRoundTripEqual(paragraphs, back.paragraphs), true, `formatting drifted through ${JSON.stringify(rendered)}`);
  return rendered;
}

test("title/heading/subheading render as #/##/### and round-trip", () => {
  const rendered = assertRoundTrips([p("title", "My Note"), p("heading", "H"), p("subheading", "S"), p("body", "text")]);
  assert.equal(rendered, "# My Note\n## H\n### S\ntext");
});

test("checklists render as GFM task items, including empty ones", () => {
  const rendered = assertRoundTrips([
    p("todoList", "one", { done: false }),
    p("todoList", "two", { done: true }),
    p("todoList", "", { done: false }),
    p("todoList", "", { done: true }),
  ]);
  assert.equal(rendered, "- [ ] one\n- [x] two\n- [ ]\n- [x]");
});

test("a bullet item whose literal text is [ ] renders escaped and stays a bullet", () => {
  const rendered = assertRoundTrips([p("bulletList", "[ ]")]);
  assert.notEqual(rendered, "- [ ]");
});

test("blank lines are real empty paragraphs everywhere - between blocks, between lists, in quotes", () => {
  assertRoundTrips([p("body", "a"), p("body", ""), p("body", ""), p("body", "b")]);
  assertRoundTrips([p("bulletList", "a"), p("body", ""), p("bulletList", "b")]);
  assertRoundTrips([p("body", "q1", { blockQuoteLevel: 1 }), p("body", "", { blockQuoteLevel: 1 }), p("body", "q2", { blockQuoteLevel: 1 })]);
  assertRoundTrips([p("body", "a"), p("body", "")]); // trailing newline
});

test("list nesting, type switches, and numbered starts round-trip", () => {
  assertRoundTrips([
    p("bulletList", "top"),
    p("bulletList", "deep", { indent: 1 }),
    p("numberedList", "num", { indent: 1 }),
    p("bulletList", "back"),
  ]);
  const rendered = assertRoundTrips([p("numberedList", "five", { startNumber: 5 }), p("numberedList", "six")]);
  assert.equal(rendered, "5. five\n6. six");
});

test("dash lists render as - items (projection collapses them into bullets)", () => {
  const rendered = renderNoteMarkdown([p("dashList", "item")]);
  assert.equal(rendered, "- item");
});

test("a body line directly after a list or quote is not lazily absorbed", () => {
  const list = assertRoundTrips([p("bulletList", "item"), p("body", "directly after")]);
  assert.equal(list, "- item\ndirectly after");
  const quote = assertRoundTrips([p("body", "quoted", { blockQuoteLevel: 1 }), p("body", "outside")]);
  assert.equal(quote, "> quoted\noutside");
});

test("monospaced paragraphs group into a fenced block, preserving interior blanks and escalating fences", () => {
  const rendered = assertRoundTrips([
    p("body", "before"),
    p("monospaced", "code line"),
    p("monospaced", ""),
    p("monospaced", "more"),
    p("body", "after"),
  ]);
  assert.equal(rendered, "before\n```\ncode line\n\nmore\n```\nafter");
  // A mono line that is itself ``` needs a longer fence.
  assertRoundTrips([p("monospaced", "```"), p("monospaced", "inner")]);
});

test("markdown-significant plain text renders escaped", () => {
  assertRoundTrips([
    p("body", "- [ ] not a todo"),
    p("body", "# not a heading"),
    p("body", "1. not a list"),
    p("body", "> not a quote"),
    p("body", "a <u>literal</u> b"),
    p("body", "*stars* and _underscores_"),
  ]);
});

test("inline styles nest and round-trip; whole-range styles wrap outermost", () => {
  assertRoundTrips([
    {
      ...p("body", "bold italic struck under"),
      spans: [
        { ...PLAIN_STYLE, bold: true, length: 4 },
        { ...PLAIN_STYLE, length: 1 },
        { ...PLAIN_STYLE, italic: true, length: 6 },
        { ...PLAIN_STYLE, length: 1 },
        { ...PLAIN_STYLE, strikethrough: true, length: 6 },
        { ...PLAIN_STYLE, length: 1 },
        { ...PLAIN_STYLE, underline: true, length: 5 },
      ],
    },
  ]);
  // A whole-line italic containing a bold word must not produce ambiguous
  // adjacent delimiter runs (the s15 regression from the live probe note).
  const rendered = assertRoundTrips([
    {
      ...p("body", "s15 rest of line"),
      spans: [
        { ...PLAIN_STYLE, bold: true, italic: true, length: 3 },
        { ...PLAIN_STYLE, italic: true, length: 13 },
      ],
    },
  ]);
  assert.equal(rendered, "***s15** rest of line*");
});

test("explicit links round-trip; bare URLs stay plain text in both directions", () => {
  const linked = assertRoundTrips([
    {
      ...p("body", "see docs here"),
      spans: [
        { ...PLAIN_STYLE, length: 4 },
        { ...PLAIN_STYLE, link: "https://example.com/", length: 9 },
      ],
    },
  ]);
  assert.equal(linked, "see [docs here](https://example.com/)");
  // A bare-URL link span normalizes away; the rendered text suppresses the
  // GFM autolink with an escape, and parsing ignores autolink literals.
  assertRoundTrips([
    { ...p("body", "https://example.com/x"), spans: [{ ...PLAIN_STYLE, link: "https://example.com/x", length: 21 }] },
  ]);
});

test("checklists inside blockquotes round-trip", () => {
  const rendered = assertRoundTrips([p("todoList", "quoted todo", { done: false, blockQuoteLevel: 1 })]);
  assert.equal(rendered, "> - [ ] quoted todo");
});

test("U+FFFC placeholders pass through rendering and parsing untouched", () => {
  assertRoundTrips([p("body", "￼"), p("body", "text ￼ inline")]);
});

/** Parses `markdown`, asserting that it parses, and that it renders back
 * byte-identically - the property literal degradation exists for. */
function assertLiteral(markdown: string): FormatParagraph[] {
  const parsed = parseNoteMarkdown(markdown);
  assert.equal(parsed.status, "ok", parsed.status === "ok" ? undefined : parsed.reason);
  if (parsed.status !== "ok") throw new Error("unreachable");
  assert.ok(parsed.literalLines > 0, "expected literal lines");
  assert.equal(renderNoteMarkdown(parsed.paragraphs), markdown);
  return parsed.paragraphs;
}

test("parser carries block constructs Apple Notes can't express as literal Body lines", () => {
  const deep = assertLiteral("#### too deep");
  assert.deepEqual(
    deep.map((x) => [x.kind, x.text]),
    [["body", "#### too deep"]],
  );

  const rule = assertLiteral("a\n\n---\n\nb");
  assert.deepEqual(
    rule.map((x) => [x.kind, x.text]),
    [["body", "a"], ["body", ""], ["body", "---"], ["body", ""], ["body", "b"]],
  );

  assertLiteral("<div>\nblock\n</div>");
  assertLiteral("| a | b |\n|---|---|\n| 1 | 2 |");
  assertLiteral("See a[^1].\n\n[^1]: The footnote.");
  assertLiteral("See [x][ref].\n\n[ref]: https://example.com");
  assertLiteral("##### five\n###### six");
});

test("literal lines keep their own blockquote depth and list indentation", () => {
  const quoted = assertLiteral("> #### Deep quoted\n> ---\n>\n> after");
  assert.deepEqual(
    quoted.map((x) => [x.kind, x.blockQuoteLevel, x.text]),
    [
      ["body", 1, "#### Deep quoted"],
      ["body", 1, "---"],
      ["body", 1, ""],
      ["body", 1, "after"],
    ],
  );

  const fenced = assertLiteral("- item\n  ```\n  code\n  ```\n- next");
  assert.deepEqual(
    fenced.map((x) => [x.kind, x.text]),
    [
      ["bulletList", "item"],
      ["body", "  ```"],
      ["body", "  code"],
      ["body", "  ```"],
      ["bulletList", "next"],
    ],
  );

  assertLiteral("- item\n\n  > quoted in list");
  assertLiteral("1. one\n   #### deep in ordered");
});

test("a construct on a list item's marker line takes the marker with it", () => {
  const parsed = parseNoteMarkdown("- #### heading item\n\n  para");
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  // The item's later paragraph is a continuation, not the item's first line.
  assert.deepEqual(
    parsed.paragraphs.map((x) => [x.kind, x.text]),
    [["body", "- #### heading item"], ["body", ""], ["body", "para"]],
  );
  assertRoundTrips(parsed.paragraphs);
});

test("parser degrades unsupported inline constructs to their literal source text", () => {
  const result = parseNoteMarkdown("some `inline code` here");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.text, "some `inline code` here");
});

test("parser splits lazy continuations out of lists and quotes as Body paragraphs", () => {
  const result = parseNoteMarkdown("> quoted\nlazy line");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(
    result.paragraphs.map((q) => [q.kind, q.blockQuoteLevel, q.text]),
    [
      ["body", 1, "quoted"],
      ["body", 0, "lazy line"],
    ],
  );
});

test("parser accepts common hand-written variants the renderer never emits", () => {
  // Asterisk bullets, ordered lists renumbered oddly, setext headings.
  const bullets = parseNoteMarkdown("* item");
  assert.equal(bullets.status, "ok");
  if (bullets.status === "ok") assert.equal(bullets.paragraphs[0]?.kind, "bulletList");

  const setext = parseNoteMarkdown("Title\n=====");
  assert.equal(setext.status, "ok");
  if (setext.status === "ok") {
    assert.deepEqual(
      setext.paragraphs.map((q) => [q.kind, q.text]),
      [["title", "Title"]],
    );
  }
});

test("trailing whitespace is trimmed out of the projection instead of rendering as &#x20;", () => {
  // A device-typed trailing space (with bold covering it, like the real
  // "Outfits " heading) renders trimmed, with the span shrunk to match.
  const bold: InlineSpan = { ...PLAIN_STYLE, bold: true, length: 8 };
  const heading = renderNoteMarkdown([p("title", "Outfits ", { spans: [bold] })]);
  assert.equal(heading, "# **Outfits**");

  assert.equal(renderNoteMarkdown([p("body", "Fried Egg ")]), "Fried Egg");
  assert.equal(renderNoteMarkdown([p("bulletList", "item\t ")]), "- item");

  // The projection comparison agrees: trailing whitespace is not a difference.
  assert.equal(formatsRoundTripEqual([p("body", "Fried Egg ")], [p("body", "Fried Egg")]), true);

  // Monospaced paragraphs keep trailing whitespace - fences preserve it.
  const mono = renderNoteMarkdown([p("monospaced", "code  ")]);
  assert.equal(mono, "```\ncode  \n```");
  const monoBack = parseNoteMarkdown(mono);
  assert.equal(monoBack.status, "ok");
  if (monoBack.status === "ok") assert.equal(monoBack.paragraphs[0]?.text, "code  ");
});

test("parser trims trailing whitespace, including &#x20; references in older files", () => {
  const parsed = parseNoteMarkdown("# **Outfits**&#x20;\nplain trailing \nFried Egg&#x20;");
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  assert.deepEqual(
    parsed.paragraphs.map((q) => [q.kind, q.text]),
    [
      ["title", "Outfits"],
      ["body", "plain trailing"],
      ["body", "Fried Egg"],
    ],
  );
  assert.equal(parsed.text, "Outfits\nplain trailing\nFried Egg");
});

test("bare URLs render unescaped and round-trip as plain text", () => {
  const rendered = assertRoundTrips([p("body", "Possibly Montrose Beach?: https://maps.app.goo.gl/cXebu5pyuyk9sNsG6")]);
  assert.equal(rendered, "Possibly Montrose Beach?: https://maps.app.goo.gl/cXebu5pyuyk9sNsG6");

  // Whole-line URL, URL in a bullet, URL in a heading, parenthesized URL.
  assert.equal(assertRoundTrips([p("body", "https://example.com/a?b=1&c=2")]), "https://example.com/a?b=1&c=2");
  assert.equal(assertRoundTrips([p("bulletList", "see https://example.com/x")]), "- see https://example.com/x");
  assert.equal(assertRoundTrips([p("heading", "See https://example.com")]), "## See https://example.com");
  assert.equal(assertRoundTrips([p("body", "(https://example.com)")]), "(https://example.com)");
});

test("ordinary words keep the punctuation GFM autolink literals make ambiguous", () => {
  // The reported case: `remark-stringify` escapes a `.` after any `w`, so
  // only two of these four dots were ever ambiguous, and neither was a link.
  assert.equal(assertRoundTrips([p("body", "Www.VJW.digital.go.jp")]), "Www.VJW.digital.go.jp");

  // The same escape lands in prose that has nothing to do with links.
  assert.equal(assertRoundTrips([p("body", "Edit the flow.ts file")]), "Edit the flow.ts file");
  assert.equal(assertRoundTrips([p("body", "call window.open() now")]), "call window.open() now");
  assert.equal(assertRoundTrips([p("body", "a new.txt file")]), "a new.txt file");
  assert.equal(assertRoundTrips([p("body", "W.W.")]), "W.W.");
  // ... and the `@` rule does the same to an email address.
  assert.equal(assertRoundTrips([p("body", "email me@example.com please")]), "email me@example.com please");

  // A real www autolink is written bare too: reparsing makes it an autolink
  // literal, which is not a link span, so the projection is unchanged.
  assert.equal(assertRoundTrips([p("body", "See www.example.com for more")]), "See www.example.com for more");

  // Every block kind a note can put text in.
  assert.equal(assertRoundTrips([p("heading", "See www.example.com")]), "## See www.example.com");
  assert.equal(assertRoundTrips([p("bulletList", "see flow.ts")]), "- see flow.ts");
  assert.equal(assertRoundTrips([p("todoList", "read flow.ts", { done: false })]), "- [ ] read flow.ts");
  assert.equal(assertRoundTrips([p("body", "see flow.ts", { blockQuoteLevel: 1 })]), "> see flow.ts");

  // Wholly inside one styled span, and alongside Obsidian notation.
  assert.equal(
    assertRoundTrips([
      {
        ...p("body", "see flow.ts now"),
        spans: [
          { ...PLAIN_STYLE, length: 4 },
          { ...PLAIN_STYLE, bold: true, length: 7 },
          { ...PLAIN_STYLE, length: 4 },
        ],
      },
    ]),
    "see **flow.ts** now",
  );
  assert.equal(assertRoundTrips([p("body", "[[Note]] and flow.ts")]), "[[Note]] and flow.ts");
  // A line-leading tag and the token starting at the same offset are one run.
  assert.equal(assertRoundTrips([p("body", "#new.stuff")]), "#new.stuff");

  // An Apple link span still renders as a real markdown link.
  assert.equal(
    assertRoundTrips([
      { ...p("body", "www.example.com"), spans: [{ ...PLAIN_STYLE, link: "http://www.example.com", length: 15 }] },
    ]),
    "[www.example.com](http://www.example.com)",
  );
});

test("tokens that aren't safe to write raw still round-trip, and real markdown keeps its escapes", () => {
  // Emphasis-active characters and entity-shaped runs can't ride along in a
  // raw token, and a raw run must end at whitespace or the end of the line
  // (an autolink literal would swallow what follows). These lines still come
  // out unescaped - as literal lines, which reparse as GFM autolink literals
  // and collapse back to the same plain text - but only because the reparse
  // check says so; see "literal lines" below.
  assert.equal(assertRoundTrips([p("body", "www.exa_mple.com")]), "www.exa_mple.com");
  assert.equal(assertRoundTrips([p("body", "www.exa*mple*.com")]), "www.exa*mple*.com");
  assert.equal(assertRoundTrips([p("body", 'say "www.example.com" ok')]), 'say "www.example.com" ok');
  // Inside an autolink literal an entity-shaped run stays text, so even
  // this line passes the check.
  assert.equal(assertRoundTrips([p("body", "www.example.com/?a&amp;b")]), "www.example.com/?a&amp;b");
  // Real markdown still gets its escapes, even carrying a token.
  assert.equal(assertRoundTrips([p("body", "# heading www.example.com")]), "\\# heading www.example.com");
});

test("each unescaping rule stands on its own when the other one fails", () => {
  // `[ ]` written bare in a bullet would become a checkbox, so the Obsidian
  // spelling is rejected for this note - but that must not cost the note the
  // unrelated `flow.ts`, which is why the spellings are tried in combination.
  assert.equal(assertRoundTrips([p("bulletList", "[ ]"), p("body", "flow.ts")]), "- \\[ ]\nflow.ts");
  // The mirror image: the token here can't be written raw (`_`), and the
  // wikilink still keeps its brackets - and then the whole line can be
  // literal anyway.
  assert.equal(assertRoundTrips([p("body", "[[Note]] and www.exa_mple.com")]), "[[Note]] and www.exa_mple.com");
});

test("Obsidian wikilinks keep their bare brackets and round-trip as plain text", () => {
  const rendered = assertRoundTrips([
    p("body", "Between Osaka and Kyoto, do not take a [[Shinkansen]] -- it's close enough for a normal train."),
  ]);
  assert.equal(rendered, "Between Osaka and Kyoto, do not take a [[Shinkansen]] -- it's close enough for a normal train.");

  // Alias, heading/section target, embed, two in one line, and the same in
  // the other block kinds a note can put text in.
  assert.equal(assertRoundTrips([p("body", "See [[Note|alias]] here")]), "See [[Note|alias]] here");
  assert.equal(assertRoundTrips([p("body", "[[Folder/Note#Heading]]")]), "[[Folder/Note#Heading]]");
  assert.equal(assertRoundTrips([p("body", "![[embed.png]]")]), "![[embed.png]]");
  assert.equal(assertRoundTrips([p("body", "[[a]] and [[b]]")]), "[[a]] and [[b]]");
  assert.equal(assertRoundTrips([p("bulletList", "see [[Note]]")]), "- see [[Note]]");
  assert.equal(assertRoundTrips([p("todoList", "read [[Note]]", { done: false })]), "- [ ] read [[Note]]");
  assert.equal(assertRoundTrips([p("heading", "About [[Note]]")]), "## About [[Note]]");
  assert.equal(assertRoundTrips([p("body", "quoted [[Note]]", { blockQuoteLevel: 1 })]), "> quoted [[Note]]");

  // A wikilink wholly inside one styled span still renders raw.
  assert.equal(
    assertRoundTrips([
      {
        ...p("body", "go to [[Note]] now"),
        spans: [
          { ...PLAIN_STYLE, length: 6 },
          { ...PLAIN_STYLE, bold: true, length: 8 },
          { ...PLAIN_STYLE, length: 4 },
        ],
      },
    ]),
    "go to **[[Note]]** now",
  );
});

test("bracket runs that aren't safe to emit raw stay escaped but still round-trip", () => {
  // `[[a]](b)` would reparse as a real link.
  assertRoundTrips([p("body", "[[a]](b)")]);
  // Characters that could open an inline construct or eat the next one.
  assertRoundTrips([p("body", "[[a_b]]")]);
  assertRoundTrips([p("body", "[[a*b]]")]);
  assertRoundTrips([p("body", "[[a\\b]]")]);
  assertRoundTrips([p("body", "[[a&amp;b]]")]);
  assertRoundTrips([p("body", "[[a<b>c]]")]);
  assertRoundTrips([p("body", "[[a`b]]")]);
  // Unbalanced or nested brackets aren't wikilinks at all.
  assertRoundTrips([p("body", "[[a]")]);
  assertRoundTrips([p("body", "[a]]")]);
  assertRoundTrips([p("body", "[[[a]]")]);
  assertRoundTrips([p("body", "[[a [[b]] c]]")]);
  // A wikilink straddling a style boundary falls back to escaped text.
  assertRoundTrips([
    {
      ...p("body", "[[Note]]"),
      spans: [
        { ...PLAIN_STYLE, bold: true, length: 4 },
        { ...PLAIN_STYLE, length: 4 },
      ],
    },
  ]);
  // A bracket run that would become a link if written bare.
  assert.equal(assertRoundTrips([p("body", "[a](b)")]), "\\[a]\\(b)");
  // These two only *look* like links: a reference with no definition is
  // text, and a definition degrades to its literal line on parse - so as
  // whole literal lines they are safe.
  assert.equal(assertRoundTrips([p("body", "[a][b]")]), "[a][b]");
  assert.equal(assertRoundTrips([p("body", "[a]: https://example.com")]), "[a]: https://example.com");
});

test("Obsidian callouts, tags, highlights and footnotes keep their notation too", () => {
  // Callouts: the `[!TYPE]` head of a blockquote line, foldable or not.
  assert.equal(assertRoundTrips([p("body", "[!NOTE] Worth knowing", { blockQuoteLevel: 1 })]), "> [!NOTE] Worth knowing");
  assert.equal(assertRoundTrips([p("body", "[!TIP]- Folded", { blockQuoteLevel: 1 })]), "> [!TIP]- Folded");
  assert.equal(
    assertRoundTrips([p("body", "[!WARNING]", { blockQuoteLevel: 1 }), p("body", "body line", { blockQuoteLevel: 1 })]),
    "> [!WARNING]\n> body line",
  );

  // Tags: an ATX heading needs whitespace (or end of line) after its `#`s,
  // so a line-leading tag is not ambiguous with one.
  assert.equal(assertRoundTrips([p("body", "#project")]), "#project");
  assert.equal(assertRoundTrips([p("body", "#work/urgent and #done")]), "#work/urgent and #done");
  assert.equal(assertRoundTrips([p("body", "intro"), p("body", "#project")]), "intro\n#project");
  assert.equal(assertRoundTrips([p("bulletList", "#project")]), "- #project");

  // Highlights: a setext underline is a line of *nothing but* `=`.
  assert.equal(assertRoundTrips([p("body", "==highlight== and more")]), "==highlight== and more");
  assert.equal(assertRoundTrips([p("body", "intro"), p("body", "==highlight==")]), "intro\n==highlight==");

  // Footnotes, both spellings, and plain bracketed prose.
  assert.equal(assertRoundTrips([p("body", "See [^1] for the details")]), "See [^1] for the details");
  assert.equal(assertRoundTrips([p("body", "See ^[an inline note] there")]), "See ^[an inline note] there");
  assert.equal(assertRoundTrips([p("body", "[Shinkansen]")]), "[Shinkansen]");
});

test("markup that really is markdown stays escaped", () => {
  // A real heading, and the two shapes that are still headings.
  assert.equal(assertRoundTrips([p("body", "# Real heading")]), "\\# Real heading");
  assert.equal(assertRoundTrips([p("body", "#")]), "\\#");
  assert.equal(assertRoundTrips([p("body", "#\tTabbed")]), "\\#\tTabbed");
  // A line of nothing but `=` (or `-`) under prose is a setext underline.
  assert.equal(assertRoundTrips([p("body", "intro"), p("body", "===")]), "intro\n\\===");
  assert.equal(assertRoundTrips([p("body", "intro"), p("body", "---")]), "intro\n\\---");
  // A character reference would decode.
  assert.equal(assertRoundTrips([p("body", "&amp;")]), "\\&amp;");
  // Emphasis typed as text on a device would become real emphasis.
  assert.equal(assertRoundTrips([p("body", "*not italic*")]), "\\*not italic\\*");
});

test("the Obsidian spelling is dropped whole when it would change the document", () => {
  // `[ ]` is an inert bracket run by every rule above - but writing it bare
  // in a bullet makes GFM read a checkbox, so the reparse check rejects the
  // Obsidian spelling for this note and the escaped one is emitted instead.
  const rendered = assertRoundTrips([p("bulletList", "[ ]")]);
  assert.notEqual(rendered, "- [ ]");

  // The fallback is per *note*, not per run - but literal lines are then
  // tried line by line, so the wikilink sharing the file gets its bare
  // brackets back anyway.
  assert.equal(assertRoundTrips([p("bulletList", "[ ]"), p("body", "[[Note]]")]), "- \\[ ]\n[[Note]]");
});

test("literal lines: markdown stored as note text comes back as that markdown", () => {
  // What `parseNoteMarkdown` carries literally - and what someone might type
  // on a device - is written back unescaped wherever reparsing provably
  // yields the same note.
  assert.equal(assertRoundTrips([p("body", "Use `npm test` here")]), "Use `npm test` here");
  assert.equal(assertRoundTrips([p("bulletList", "run `npm test`")]), "- run `npm test`");
  assert.equal(assertRoundTrips([p("heading", "The `x` flag")]), "## The `x` flag");
  assert.equal(assertRoundTrips([p("body", "![alt](image.png)")]), "![alt](image.png)");
  assert.equal(assertRoundTrips([p("body", "#### Deep")]), "#### Deep");
  assert.equal(assertRoundTrips([p("body", "<div>x</div>")]), "<div>x</div>");
  assert.equal(assertRoundTrips([p("body", "[^1]: the footnote")]), "[^1]: the footnote");
  assert.equal(assertRoundTrips([p("body", "intro"), p("body", ""), p("body", "---")]), "intro\n\n---");
  assert.equal(assertRoundTrips([p("body", "#### Quoted", { blockQuoteLevel: 1 })]), "> #### Quoted");
  assert.equal(
    assertRoundTrips([p("body", "| a | b |"), p("body", "|---|---|"), p("body", "| 1 | 2 |")]),
    "| a | b |\n|---|---|\n| 1 | 2 |",
  );
  // Inside one styled span, the piece is still literal.
  assert.equal(
    assertRoundTrips([
      {
        ...p("body", "run `x` now"),
        spans: [
          { ...PLAIN_STYLE, length: 4 },
          { ...PLAIN_STYLE, bold: true, length: 3 },
          { ...PLAIN_STYLE, length: 4 },
        ],
      },
    ]),
    "run **`x`** now",
  );
});

test("literal lines are judged per line, in context, and fall back to escaping", () => {
  // A lone fence would swallow the rest of the note; a pair would make a
  // code block. Neither is the same note, so both stay escaped - and the
  // unrelated line still goes literal.
  assert.equal(assertRoundTrips([p("body", "```"), p("body", "x"), p("body", "```")]), "\\`\\`\\`\nx\n\\`\\`\\`");
  assert.equal(assertRoundTrips([p("body", "```"), p("body", "`y`")]), "\\`\\`\\`\n`y`");
  // A first line of exactly `---` would read as a frontmatter fence.
  assert.equal(assertRoundTrips([p("body", "---"), p("body", "x")]), "\\---\nx");
  assert.equal(assertRoundTrips([p("body", "---")]), "\\---");
});

test("URLs that could open inline constructs fall back to escaped text but still round-trip", () => {
  // `_` is outside the raw-URL character set; the tail renders escaped.
  assertRoundTrips([p("body", "https://en.wikipedia.org/wiki/A_B")]);
  // Entity-shaped runs must not be emitted raw (they would decode on reparse).
  assertRoundTrips([p("body", "https://example.com/?a&amp;b")]);
  // Mid-word URLs aren't autolink candidates; they stay escaped text.
  assertRoundTrips([p("body", "foohttps://example.com")]);
  // Emphasis-active characters in the URL.
  assertRoundTrips([p("body", "https://example.com/*star*")]);
});

test("a fence's info string is kept by carrying the block literally", () => {
  // Monospaced paragraphs can't hold a language, and dropping it broke the
  // Obsidian plugin reading the block: this used to come back as a bare
  // fence.
  const paragraphs = assertLiteral("```js\nconst x = 1;\n```");
  assert.deepEqual(
    paragraphs.map((x) => [x.kind, x.text]),
    [["body", "```js"], ["body", "const x = 1;"], ["body", "```"]],
  );
  assertLiteral('```js title="x.js"\nx\n```');
  assertLiteral("> ```dataview\n> LIST\n> ```");

  // A fence without one is still a monospaced block.
  const plain = parseNoteMarkdown("```\nconst x = 1;\n```");
  assert.equal(plain.status, "ok");
  if (plain.status !== "ok") return;
  assert.deepEqual(
    plain.paragraphs.map((x) => [x.kind, x.text]),
    [["monospaced", "const x = 1;"]],
  );
  assert.equal(plain.literalLines, 0);
});

test("an Obsidian itinerary note round-trips byte for byte", () => {
  // A real note: plugin blocks keyed by their fence's language, between
  // headings and prose, including a prose line directly above a heading.
  const itinerary = [
    "```itinerary",
    "initialDate: 2026-12-16",
    "```",
    "",
    "# ORD -> TOK",
    "```itinerary-event",
    "title: ORD->HND (UA 881)",
    "start: 2026-12-16T13:05",
    "end: 2026-12-17T17:45",
    "startTimeZone: America/Chicago",
    "endTimeZone: Asia/Tokyo",
    "tag:",
    "- flight",
    "```",
    "",
    "United confirmation EM8E7E; seats 55K and 55L.",
    "# Tokyo",
    "```itinerary-event",
    "start: 2026-12-17",
    "end: 2026-12-21",
    "title: Tokyo",
    "tag: city",
    "```",
    "",
    "# TOK -> LAX",
    "",
    "```itinerary-event",
    "title: NRT->LAX (UA 33)",
    "start: 2026-12-29T17:30",
    "color: blue",
    "tag:",
    "- flight",
    "```",
    "",
    "Departs from Narita, not Haneda.",
  ].join("\n");
  const paragraphs = assertLiteral(itinerary);
  assert.equal(readsBackFaithfully(paragraphs), true);
  // The headings are still real headings in the note.
  assert.deepEqual(
    paragraphs.filter((x) => x.kind === "title").map((x) => x.text),
    ["ORD -> TOK", "Tokyo", "TOK -> LAX"],
  );
});

test("readsBackFaithfully reports whether a note survives the pull-side round trip", () => {
  assert.equal(readsBackFaithfully([p("body", "---"), p("body", "#### Deep")]), true);
  // A list nested two levels deeper than its parent has no markdown
  // spelling that parses back to the same indents.
  assert.equal(readsBackFaithfully([p("bulletList", "a"), p("bulletList", "b", { indent: 2 })]), false);
});

test("a fence left unclosed in a list item doesn't take the next item's line with it", () => {
  // remark ends the fence at column 1 of the next item's marker line; that
  // line must reach the note once, as the item it is.
  for (const markdown of ["- ```js\n  a\n- b", "- a\n  ```js\n  x\n- b", "> - ```js\n>   a\n> - b"]) {
    const parsed = parseNoteMarkdown(markdown);
    assert.equal(parsed.status, "ok");
    if (parsed.status !== "ok") continue;
    const texts = parsed.paragraphs.map((x) => x.text);
    assert.equal(texts.filter((text) => text.endsWith("b")).length, 1, `duplicated a line: ${JSON.stringify(texts)}`);
    assert.equal(parsed.paragraphs[parsed.paragraphs.length - 1]!.kind, "bulletList");
    assert.equal(renderNoteMarkdown(parsed.paragraphs), markdown);
  }
});

test("in a note with embeds, literal lines never add table- or marker-shaped text", () => {
  // Push finds each embed's table block by scanning the text and refuses on
  // an extra one, so phone-typed pipes stay escaped next to a real embed...
  const withEmbed = renderNoteMarkdown([p("body", "￼"), p("body", "|a|b|"), p("body", "|-|-|"), p("body", "Use `x`")]);
  assert.match(withEmbed, /\\\|-\|-\|/);
  assert.match(withEmbed, /Use `x`/);
  // ...and are literal without one.
  assert.equal(assertRoundTrips([p("body", "|a|b|"), p("body", "|-|-|")]), "|a|b|\n|-|-|");
});
