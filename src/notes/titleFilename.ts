/**
 * The two-way projection between a note's title and its file name.
 *
 * `filename.ts` sanitizes a title into a *display* name and stops there -
 * fine when the title also lives in the note body, since nothing needs to
 * read it back. Under `--filename-as-title` the file name is the only place
 * the title lives, so the mapping has to be reversible, and it has to
 * survive three filesystems at once:
 *
 *  - **Windows**: `\ / : * ? " < > |` are illegal, a trailing `.` or space
 *    is silently stripped, and the DOS device names (`CON`, `PRN`, `AUX`,
 *    `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`) are reserved even *with* an
 *    extension - `CON.md` is still reserved.
 *  - **macOS**: `/` is illegal and `:` is hostile (the Finder still shows it
 *    as a path separator in places).
 *  - **Obsidian**, which is the point of the mode: `#`, `^`, `[` and `]` are
 *    rejected in file names because they're wikilink syntax.
 *
 * ## Homoglyphs, not escapes
 *
 * Illegal characters map to visually-near Unicode characters that are legal
 * everywhere (`/` -> U+2044 FRACTION SLASH, and so on), the same device
 * rclone and Bear use. Percent-encoding was rejected because this name is
 * human-facing text in Obsidian's sidebar: `My %2F Note` reads as a bug,
 * `My ⁄ Note` reads as a title.
 *
 * The substitution is a *read-direction* device. Pull writes the file name
 * and does the mapping; nobody types a homoglyph by hand. The consequence is
 * an asymmetry worth being explicit about: a title containing `/` stays
 * readable and stays preserved, but a user cannot *introduce* one by
 * renaming a file, because their filesystem won't let them type it.
 *
 * A title that already contains a homoglyph round-trips wrong (it would
 * decode into the ASCII character it stands for), so those are escaped on
 * the way out - see `ESCAPE`.
 *
 * ## When the file name isn't enough
 *
 * Some titles can't be carried by a file name at all - too long, a leading
 * `.`, a reserved device name. `titleIsRepresentable` identifies them, and
 * the caller records the real title in `apple-note-title` frontmatter
 * instead.
 *
 * The key says "the title this file's name doesn't carry", which is not
 * quite the same as "a title no name *could* carry". Both `pull` (writing
 * one) and `push` (reading one) treat it as outranking the name, so it is
 * also how a user asks for a new title their file name can't express: they
 * write the key, `push` sends the retitle, and `pull` renames the file and
 * clears the key again if the new title turns out to be representable after
 * all. Outside that round trip the key stays absent, which is what keeps it
 * from becoming a second source of truth for titles a name holds fine.
 */

/** Illegal (or Obsidian-hostile) character -> the legal character that
 * stands in for it. Every value is outside the set of characters any of the
 * three filesystems object to. */
const HOMOGLYPHS: ReadonlyMap<string, string> = new Map([
  ["/", "⁄"], // FRACTION SLASH
  ["\\", "⧵"], // REVERSE SOLIDUS OPERATOR
  [":", "꞉"], // MODIFIER LETTER COLON
  ["*", "∗"], // ASTERISK OPERATOR
  ["?", "？"], // FULLWIDTH QUESTION MARK
  ['"', "”"], // RIGHT DOUBLE QUOTATION MARK
  ["<", "‹"], // SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  [">", "›"], // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  ["|", "❘"], // LIGHT VERTICAL BAR
  ["#", "＃"], // FULLWIDTH NUMBER SIGN (Obsidian: heading link)
  ["^", "＾"], // FULLWIDTH CIRCUMFLEX ACCENT (Obsidian: block link)
  ["[", "［"], // FULLWIDTH LEFT SQUARE BRACKET (Obsidian: wikilink)
  ["]", "］"], // FULLWIDTH RIGHT SQUARE BRACKET (Obsidian: wikilink)
]);

const DECODE: ReadonlyMap<string, string> = new Map(
  [...HOMOGLYPHS].map(([literal, homoglyph]) => [homoglyph, literal]),
);

/**
 * A title character that is *already* a homoglyph would decode into
 * something else entirely, so it's prefixed with U+2060 WORD JOINER - a
 * zero-width, legal, non-printing character. Decoding drops the joiner and
 * keeps the homoglyph as itself. Vanishingly rare in practice; correctness
 * is the point rather than ergonomics.
 */
const ESCAPE = "⁠";

/** Windows reserved device names, which are reserved with any extension. */
const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * How long a title may be before the file name can't hold it. Well under the
 * 255-*byte* limit every mainstream filesystem imposes, since a UTF-8 title
 * can spend up to four bytes per character and the ".md" extension and any
 * " 2" uniquifier suffix have to fit too.
 */
export const MAX_TITLE_LENGTH = 60;

/** Encodes a title into a file-name stem that is legal on macOS, Windows and
 * Linux, and acceptable to Obsidian. Reversible via `decodeTitleStem`. */
export function encodeTitleStem(title: string): string {
  let out = "";
  for (const character of title) {
    if (DECODE.has(character)) {
      out += ESCAPE + character;
    } else {
      out += HOMOGLYPHS.get(character) ?? character;
    }
  }
  return out;
}

/** Recovers a title from a file-name stem produced by `encodeTitleStem`. */
export function decodeTitleStem(stem: string): string {
  let out = "";
  let escaped = false;
  for (const character of stem) {
    if (character === ESCAPE) {
      escaped = true;
      continue;
    }
    if (escaped) {
      out += character;
      escaped = false;
      continue;
    }
    out += DECODE.get(character) ?? character;
  }
  return out;
}

/**
 * Whether a file name can carry this title on its own. False means the
 * caller must record the title in `apple-note-title` frontmatter, because
 * the name it can write is a lossy stand-in.
 *
 * Note what is *not* here: illegal characters. Homoglyph substitution makes
 * those representable, which is most of why the frontmatter key stays rare.
 */
export function titleIsRepresentable(title: string): boolean {
  return representabilityProblem(title) === undefined;
}

/** Why a title can't be carried by a file name, or undefined when it can.
 * Exported for the pull report, so a note that gains an `apple-note-title`
 * can say why. */
export function representabilityProblem(title: string): string | undefined {
  if (title.trim() === "") {
    return "the title is empty";
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return `the title is longer than ${MAX_TITLE_LENGTH} characters`;
  }
  if (title.startsWith(".")) {
    // Obsidian ignores dotfiles outright, so the note would vanish from the
    // vault rather than merely being hidden.
    return "the title starts with a dot, which would make it a hidden file";
  }
  if (title !== title.trimEnd() || title.endsWith(".")) {
    return "the title ends with a dot or a space, which Windows silently strips";
  }
  if (RESERVED_DEVICE_NAMES.has(title.toUpperCase())) {
    return "the title is a reserved device name on Windows";
  }
  return undefined;
}
