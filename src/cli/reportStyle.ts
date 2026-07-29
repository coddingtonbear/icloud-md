import chalk, { type ChalkInstance } from "chalk";

/**
 * The one palette every human-readable listing (`status`, `push`, and
 * eventually `pull`) draws from, after paprika-recipes' reporting module:
 * colour says what *kind* of thing happened, consistently everywhere -
 * green for something appearing, yellow for something changing in place,
 * red for something going away, cyan for something relocating.
 *
 * Two outcomes need the reader to act, so they get colours nothing routine
 * uses: magenta for a conflict (resolvable - do something, then retry), and
 * black-on-red for something this tool cannot sync at all - the one status
 * a retry won't change, so it's deliberately the loudest thing on screen.
 *
 * These are the terminal's own palette colours, and deliberately nothing
 * else: they're themed by whoever is reading, so they stay legible against
 * their background by construction. An absolute colour would be a guess
 * about a background we can't see. (The `UNSYNCABLE` background is the same
 * themed red, with the theme's "black" on top of it.)
 */
export const NEW: ChalkInstance = chalk.green;
export const CHANGED: ChalkInstance = chalk.yellow;
export const GONE: ChalkInstance = chalk.red;
export const MOVED: ChalkInstance = chalk.cyan;
export const NEEDS_ATTENTION: ChalkInstance = chalk.magenta;
export const UNSYNCABLE: ChalkInstance = chalk.bgRed.black;

/** De-emphasis for the routine remarks around a listing ("Nothing to
 * push.") - an attribute rather than a colour, so it dims the reader's own
 * foreground instead of replacing it. */
export const QUIET: ChalkInstance = chalk.dim;

/**
 * One listing line: the status label coloured and padded to a common
 * column, the subject after it in the terminal's own foreground colour.
 * `width` is the longest label in the listing's label set, so a report
 * reads as a column rather than a ragged list.
 */
export function labelledLine(label: string, color: ChalkInstance, width: number, subject: string): string {
  return `${color(label.padEnd(width))} ${subject}`;
}

/**
 * A remark line belonging to the entry above it, indented to sit under the
 * entry's subject rather than its label. The indent stays outside the
 * colour so a background style (`UNSYNCABLE`) starts at the text.
 */
export function remarkLine(color: ChalkInstance, width: number, message: string): string {
  return `${" ".repeat(width + 1)}${color(message)}`;
}
