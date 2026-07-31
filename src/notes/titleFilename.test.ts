import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carriedTitleSpelling,
  decodeTitleStem,
  encodeTitleStem,
  MAX_TITLE_LENGTH,
  representabilityProblem,
  titleIsRepresentable,
} from "./titleFilename.js";

/** Every character the three target filesystems (plus Obsidian) object to. */
const ILLEGAL = ['/', "\\", ":", "*", "?", '"', "<", ">", "|", "#", "^", "[", "]"];

test("a plain title is its own stem", () => {
  assert.equal(encodeTitleStem("Grocery list"), "Grocery list");
  assert.equal(decodeTitleStem("Grocery list"), "Grocery list");
});

test("every illegal character maps to something legal", () => {
  for (const character of ILLEGAL) {
    const stem = encodeTitleStem(`a${character}b`);
    assert.ok(!stem.includes(character), `${character} survived into the stem: ${stem}`);
  }
});

test("no encoded stem contains a character any target filesystem rejects", () => {
  const stem = encodeTitleStem(ILLEGAL.join(""));
  for (const character of ILLEGAL) {
    assert.ok(!stem.includes(character), `${character} survived into ${stem}`);
  }
});

test("illegal characters round-trip back to themselves", () => {
  for (const character of ILLEGAL) {
    const title = `before${character}after`;
    assert.equal(decodeTitleStem(encodeTitleStem(title)), title, `round trip failed for ${character}`);
  }
});

test("a title made entirely of illegal characters round-trips", () => {
  const title = ILLEGAL.join("");
  assert.equal(decodeTitleStem(encodeTitleStem(title)), title);
});

test("a title that already contains a homoglyph round-trips as itself", () => {
  // The trap this escaping exists for: without it, a real U+2044 in a title
  // would decode into "/" and silently rewrite the note's title.
  for (const title of ["Already ⁄ fraction", "Colon ꞉ here", "⧵ leading", "mixed ⁄ and / together"]) {
    assert.equal(decodeTitleStem(encodeTitleStem(title)), title, `round trip failed for ${title}`);
  }
});

test("round-tripping is stable across repeated encodes", () => {
  const title = "a/b:c*d?e|f#g";
  const once = encodeTitleStem(title);
  assert.equal(decodeTitleStem(once), title);
  // Encoding an already-decoded title must land in the same place.
  assert.equal(encodeTitleStem(decodeTitleStem(once)), once);
});

test("emoji and non-Latin scripts pass through untouched", () => {
  for (const title of ["Café ☕ notes", "日本語のノート", "Ελληνικά", "emoji 👨‍👩‍👧‍👦 family"]) {
    assert.equal(encodeTitleStem(title), title);
    assert.equal(decodeTitleStem(title), title);
  }
});

// --- representability --------------------------------------------------------

test("an ordinary title is representable, illegal characters and all", () => {
  assert.ok(titleIsRepresentable("Grocery list"));
  assert.ok(titleIsRepresentable("Recipes: pie/tart"), "homoglyphs are what keep this representable");
});

test("an over-long title is not representable", () => {
  assert.ok(titleIsRepresentable("a".repeat(MAX_TITLE_LENGTH)));
  assert.ok(!titleIsRepresentable("a".repeat(MAX_TITLE_LENGTH + 1)));
  assert.match(representabilityProblem("a".repeat(MAX_TITLE_LENGTH + 1)) ?? "", /longer than/);
});

test("a title starting with a dot is not representable - Obsidian ignores dotfiles", () => {
  assert.ok(!titleIsRepresentable(".hidden"));
  assert.match(representabilityProblem(".hidden") ?? "", /hidden file/);
});

test("a title ending in a dot is not representable - Windows strips it", () => {
  assert.ok(!titleIsRepresentable("Trailing dot."));
  assert.match(representabilityProblem("Trailing dot.") ?? "", /Windows silently strips/);
});

test("a title ending in whitespace is representable - the name carries its trimmed spelling", () => {
  // Not a relaxation of the Windows rule but a projection: the trailing
  // space never reaches the file name (see `carriedTitleSpelling`), and the
  // difference between the two spellings counts as no difference at all.
  assert.ok(titleIsRepresentable("Trailing space "));
  assert.equal(carriedTitleSpelling("Trailing space "), "Trailing space");
});

test("the trimmed spelling gets no free pass through the other checks", () => {
  // Whitespace padding must not smuggle a reserved name, an over-long
  // title, or a trailing dot past representability.
  assert.ok(!titleIsRepresentable("CON "));
  assert.match(representabilityProblem("CON ") ?? "", /reserved device name/);
  assert.ok(!titleIsRepresentable("Trailing dot. "));
  assert.ok(titleIsRepresentable(`${"x".repeat(60)} `), "padding beyond the limit trims away");
  assert.ok(!titleIsRepresentable(`${"x".repeat(61)} `));
});

test("Windows reserved device names are not representable, in any case", () => {
  for (const name of ["CON", "con", "Nul", "COM1", "lpt9", "AUX"]) {
    assert.ok(!titleIsRepresentable(name), `${name} should not be representable`);
    assert.match(representabilityProblem(name) ?? "", /reserved device name/);
  }
});

test("a name merely containing a reserved word is fine", () => {
  assert.ok(titleIsRepresentable("CONTACTS"));
  assert.ok(titleIsRepresentable("COM10"));
});

test("an empty or whitespace-only title is not representable", () => {
  assert.ok(!titleIsRepresentable(""));
  assert.ok(!titleIsRepresentable("   "));
});

test("round-tripping holds over generated character soup", () => {
  // Deterministic pseudo-random so a failure is reproducible from the seed.
  const alphabet = [
    ...ILLEGAL,
    "⁄", "꞉", "？", "❘", "＃", "［", "］", "⧵", "∗", "”", "‹", "›", "＾",
    "a", "Z", " ", ".", "-", "_", "é", "日", "☕", "⁠",
  ];
  let seed = 20260730;
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648);

  for (let iteration = 0; iteration < 2000; iteration += 1) {
    const length = next() % 12;
    let title = "";
    for (let i = 0; i < length; i += 1) {
      title += alphabet[next() % alphabet.length];
    }
    const stem = encodeTitleStem(title);
    for (const character of ILLEGAL) {
      assert.ok(!stem.includes(character), `${JSON.stringify(title)} encoded to ${JSON.stringify(stem)}`);
    }
    assert.equal(decodeTitleStem(stem), title, `round trip failed for ${JSON.stringify(title)}`);
  }
});
