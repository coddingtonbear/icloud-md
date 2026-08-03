/**
 * The web oracle: reads a note the way Apple's own web client shows it, so an
 * integration test can assert against something outside this project's own
 * encode/decode path entirely.
 *
 * Why it works the way it does (all established by live probing, 2026-07-30):
 *
 *  - icloud.com/notes boots a SPA inside an iframe served from
 *    `/applications/notes3/...`. Everything must be queried through that frame.
 *  - A note is addressable directly: the route is
 *    `/notes/note/<base64("Private::Notes::currentUser::<UUID>")>`, so a test
 *    can jump straight to a record id instead of scraping the sidebar.
 *  - The note *body is rendered to a `<canvas>`. It is not in the DOM at all,
 *    so there is nothing to scrape. The only `contenteditable` nodes are a
 *    pair of IME sentinels holding "⇨"/"⇦".
 *  - The way out is the clipboard: focus the editor, select all, copy. Apple's
 *    own client then serialises the note onto the clipboard in two flavors -
 *    `text/plain`, and a `text/html` whose every span carries a `data-tt`
 *    attribute with Apple's *native paragraph style enum*. That gives the
 *    oracle real structural fidelity (title/heading/body/lists), not just text.
 *
 * The reader never types into a note. The only keys it ever sends are
 * select-all and copy; the only click is one into the editor body to focus it.
 */

import { chromium, type BrowserContext, type Frame, type Page } from "playwright";
import path from "node:path";
import { CONFIG_DIR } from "../src/configDir.js";

/**
 * Apple's wire enum for paragraph style, decoded here *independently* of
 * `src/notes/noteFormat.ts`. Deliberately a second copy: if the oracle
 * imported the project's own mapping, a wrong mapping would cancel itself out
 * and the test would still pass. The values themselves are Apple's, confirmed
 * on the 2026-07-17 formatting capture and again on the clipboard HTML.
 */
const WEB_STYLE_TO_KIND: Record<number, WebParagraphKind> = {
  0: "title",
  1: "heading",
  2: "subheading",
  3: "body",
  4: "monospaced",
  100: "bulletList",
  101: "dashList",
  102: "numberedList",
  103: "todoList",
};

export type WebParagraphKind =
  | "title"
  | "heading"
  | "subheading"
  | "body"
  | "monospaced"
  | "bulletList"
  | "dashList"
  | "numberedList"
  | "todoList";

export interface WebParagraph {
  kind: WebParagraphKind;
  text: string;
  /** List nesting depth, as reported by the copied markup's `<ul>` nesting. */
  depth: number;
}

export interface WebNote {
  noteId: string;
  /** First line as Apple renders it - the note's effective title. */
  title: string;
  plainText: string;
  /** The raw `text/html` clipboard flavor, kept for diagnosing surprises. */
  html: string;
  paragraphs: WebParagraph[];
  /**
   * The record id the client actually has selected. Normally `noteId`; see
   * `readNote` for why it is worth carrying separately.
   */
  selectedNoteId: string;
  /**
   * Every table the client currently holds, keyed by its `Attachment` record
   * id, as rows of cell text - read out of Apple's *own* table model rather
   * than from anything this project decoded. See `readTables`.
   */
  tables: Record<string, string[][]>;
}

/**
 * One entry of `CRDTManager.mergeTraces`: the client's own copy before the
 * merge, the copy it received, and the result. Each is whatever that
 * manager's `snapshot()` produces - for text, `saveToArchive()` - serialised
 * through `JSON.stringify`, so the shape is Apple's, not ours; deliberately
 * left `unknown` rather than modelled, since nothing here should be asserting
 * on a shape we don't control.
 */
export interface MergeTrace {
  oursBefore?: unknown;
  theirsBefore?: unknown;
  oursAfter?: unknown;
}

export interface MergeTraceReport {
  date: string;
  /** Newest first. `CRDTManager` pads the array to its cap of 3 by assigning
   * `.length`, so unfilled slots arrive as null - filter before use. */
  topoTextMergeTraces: (MergeTrace | null)[];
  tableMergeTraces: (MergeTrace | null)[];
}

export interface WebNoteListRow {
  title: string;
  snippet: string;
  folder: string;
}

/** `base64("Private::Notes::currentUser::<UUID>")` - the web client's own note route token. */
export function noteRouteToken(noteId: string): string {
  return Buffer.from(`Private::Notes::currentUser::${noteId}`, "utf8").toString("base64");
}

export function noteUrl(noteId: string): string {
  return `https://www.icloud.com/notes/note/${noteRouteToken(noteId)}`;
}

/** Where `accountStore.ts` keeps the Apple-trusted Playwright profile for a dsid. */
export function profileDirForDsid(dsid: string): string {
  return path.join(CONFIG_DIR, "accounts", dsid, "browser-profile");
}

export interface OpenOracleOptions {
  dsid: string;
  headless?: boolean;
  /** How long to wait for the SPA to boot and a note to render. */
  timeoutMs?: number;
}

export class NotesWebOracle {
  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly timeoutMs: number,
  ) {}

  static async open(options: OpenOracleOptions): Promise<NotesWebOracle> {
    const timeoutMs = options.timeoutMs ?? 45_000;
    const context = await chromium.launchPersistentContext(profileDirForDsid(options.dsid), {
      headless: options.headless ?? true,
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return new NotesWebOracle(context, page, timeoutMs);
  }

  /** The notes3 SPA frame; everything lives inside it. */
  private async appFrame(): Promise<Frame> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const frame = this.page.frames().find((f) => f.url().includes("notes3"));
      if (frame) {
        return frame;
      }
      await this.page.waitForTimeout(250);
    }
    throw new Error("iCloud Notes app frame (notes3) never appeared");
  }

  /**
   * Reads one note by record id, navigating to it first - a *cold* load: the
   * client has no in-memory copy of a note it has just been sent to, so what
   * comes back is a decode of the stored bytes.
   */
  async readNote(noteId: string): Promise<WebNote> {
    await this.page.goto(noteUrl(noteId), { waitUntil: "domcontentloaded" });
    const note = await this.copyOpenNote(noteId);
    // Navigating to a note the account no longer has leaves the client
    // sitting on its previous selection, silently - so every field above
    // would describe some other note, plausibly. Refuse rather than report.
    if (note.selectedNoteId !== "" && !note.selectedNoteId.toLowerCase().includes(noteId.toLowerCase())) {
      throw new Error(
        `The web client did not open note ${noteId}; it is showing ${note.selectedNoteId} ` +
          `(titled ${JSON.stringify(note.title)}). A trashed or missing note does this.`,
      );
    }
    return note;
  }

  /**
   * Reads the note the client *already has open*, without navigating.
   *
   * This is the only way to observe a merge rather than a decode. Apple's
   * `CRDTManager.load` merges an incoming document into the copy it already
   * holds (`if (!existing) store; else merge(existing, incoming)`), so a note
   * that is open when our push lands takes the merge path - the one every
   * claim about clocks, tombstone anchors and child edges is really about.
   * Navigating here would silently turn the observation back into a cold
   * load, which agrees with whatever we wrote by construction.
   */
  async rereadOpenNote(noteId: string): Promise<WebNote> {
    return this.copyOpenNote(noteId);
  }

  /** Retries the select-all/copy cycle: the editor can be mounted but still
   * empty, and a copy landing in that window returns "" rather than failing
   * loudly. */
  private async copyOpenNote(noteId: string): Promise<WebNote> {
    const frame = await this.appFrame();
    const editor = frame.locator(".editor-container").first();
    await editor.waitFor({ state: "visible", timeout: this.timeoutMs });

    const deadline = Date.now() + this.timeoutMs;
    let lastPlain = "";
    let lastHtml = "";
    while (Date.now() < deadline) {
      const box = await editor.boundingBox();
      if (box) {
        // Focus the body, then select-all + copy. No other input is ever sent.
        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await this.page.waitForTimeout(400);
        await this.page.keyboard.press("Control+a");
        await this.page.waitForTimeout(200);
        await this.page.keyboard.press("Control+c");
        await this.page.waitForTimeout(600);

        const flavors = await this.page.evaluate(async () => {
          const result: Record<string, string> = {};
          try {
            for (const item of await navigator.clipboard.read()) {
              for (const type of item.types) {
                result[type] = await (await item.getType(type)).text();
              }
            }
          } catch {
            // Clipboard not ready yet; the caller retries.
          }
          return result;
        });

        lastPlain = flavors["text/plain"] ?? "";
        lastHtml = flavors["text/html"] ?? "";
        if (lastPlain.trim() !== "") {
          break;
        }
      }
      await this.page.waitForTimeout(750);
    }

    return {
      noteId,
      title: lastPlain.split("\n")[0] ?? "",
      plainText: lastPlain,
      html: lastHtml,
      paragraphs: lastHtml === "" ? [] : await this.parseClipboardHtml(lastHtml),
      // Read from the client's own table model, not the clipboard - see
      // `readTables`. Independent of whether the copy above succeeded.
      tables: await this.readTables(),
      selectedNoteId: await this.selectedNoteId(),
    };
  }

  /**
   * Turns the clipboard's `text/html` flavor into paragraphs. Evaluated inside
   * the page so it can use the browser's own DOMParser, rather than pulling an
   * HTML parser into this project's dependencies for test-only code.
   */
  private parseClipboardHtml(html: string): Promise<WebParagraph[]> {
    return this.page.evaluate(
      ({ html, styleMap }) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        return Array.from(doc.querySelectorAll("span[data-tt]")).map((span) => {
          let style: number | undefined;
          try {
            const parsed: unknown = JSON.parse(span.getAttribute("data-tt") ?? "");
            style = (parsed as { paragraphStyle?: { style?: number } }).paragraphStyle?.style;
          } catch {
            style = undefined;
          }

          // List depth comes from the copied markup's own <ul>/<ol> nesting.
          let nesting = 0;
          for (let cursor = span.parentElement; cursor; cursor = cursor.parentElement) {
            if (cursor.tagName === "UL" || cursor.tagName === "OL") {
              nesting += 1;
            }
          }

          return {
            // An absent `style` means Body - the same rule the wire format uses.
            kind: style === undefined ? "body" : (styleMap[style] ?? `unknown(${style})`),
            // Apple ends every paragraph span with its trailing newline.
            text: (span.textContent ?? "").replace(/\n$/, ""),
            depth: nesting > 0 ? nesting - 1 : 0,
          };
        });
      },
      { html, styleMap: WEB_STYLE_TO_KIND as Record<number, string> },
    ) as Promise<WebParagraph[]>;
  }

  /**
   * Reads every table the client currently holds, as rows of cell text, out
   * of Apple's own in-memory table model.
   *
   * The clipboard is no help for a table, which is not obvious and cost a
   * detour to establish (live probe, 2026-08-02): a table copies as the bare
   * U+FFFC placeholder span, marked `data-tt-replacement="true"`, carrying
   * none of its cells. Nor is a table in the DOM - like the note body it is
   * rendered to the canvas. Either way there is nothing to scrape.
   *
   * What there *is* is `icTableManager`, the sibling of the `topoTextManager`
   * whose merge traces these tests already read: a `CRDTManager` keyed by
   * `Private::Notes::currentUser::<attachment record id>`, holding the live
   * `CRTable` the client decoded from that attachment's bytes. Walking its
   * `_rows`/`_columns` ordered sets and reading each cell's
   * `.string.UTF16String` gives Apple's own view of the grid - its own
   * ordering, its own cell strings, its own decoder.
   *
   * That makes this a *stronger* oracle than scraped markup would have been:
   * it is the client's parse of the exact bytes we wrote, and it needs
   * neither a merge to have happened nor any UI to be driven. It is also why
   * the result is keyed by attachment id rather than by position - the
   * manager is an LRU that can still hold tables from notes visited earlier,
   * and a positional read would happily return one of those.
   */
  /**
   * The tables the client currently holds, without the clipboard round trip
   * `rereadOpenNote` performs - cheap enough to poll in a wait loop, and it
   * sends no keystrokes at all.
   */
  async tables(): Promise<Record<string, string[][]>> {
    return this.readTables();
  }

  private async readTables(): Promise<Record<string, string[][]>> {
    const frame = await this.appFrame();
    // Passed as source text, and free of inner named functions, because the
    // test runner's TypeScript transform rewrites those into calls to a
    // `__name` helper that does not exist inside the page.
    return (await frame.evaluate(`(() => {
      const debug = window.NotesApp ? window.NotesApp.Debug : undefined;
      const note = debug && debug.noteList ? debug.noteList._lastSelectedNote : undefined;
      const manager = note && note._cwStore ? note._cwStore.icTableManager : undefined;
      const out = {};
      if (!manager || !manager.data || typeof manager.data[Symbol.iterator] !== "function") {
        return out;
      }
      for (const entry of manager.data) {
        const key = String(entry[0]);
        const table = entry[1] ? entry[1].table : undefined;
        if (!table || !table._rows || !table._columns) {
          continue;
        }
        const rowIds = [];
        const columnIds = [];
        for (let i = 0; i < table._rows.size; i += 1) rowIds.push(table._rows.get(i));
        for (let i = 0; i < table._columns.size; i += 1) columnIds.push(table._columns.get(i));
        const grid = [];
        for (const rowId of rowIds) {
          const row = [];
          for (const columnId of columnIds) {
            const cell = table.cellContentsAtRowAndColumn(rowId, columnId);
            row.push(cell && cell.string && cell.string.UTF16String !== undefined ? cell.string.UTF16String : "");
          }
          grid.push(row);
        }
        out[key.slice(key.lastIndexOf(":") + 1)] = grid;
      }
      return out;
    })()`)) as Record<string, string[][]>;
  }

  /**
   * The record id the client actually has selected.
   *
   * Worth checking rather than assuming: navigating to a note that has been
   * trashed leaves the client showing whatever note it had selected before,
   * with no error of any kind (observed 2026-08-02, on a note the account had
   * quietly moved to Recently Deleted). Everything `readNote` returns would
   * then describe the wrong note, convincingly.
   */
  private async selectedNoteId(): Promise<string> {
    const frame = await this.appFrame();
    return (await frame.evaluate(`(() => {
      const debug = window.NotesApp ? window.NotesApp.Debug : undefined;
      const note = debug && debug.noteList ? debug.noteList._lastSelectedNote : undefined;
      return note && note.id !== undefined ? String(note.id) : "";
    })()`)) as string;
  }

  /**
   * The sidebar note list. Unlike bodies, these rows *are* real DOM. The list
   * is virtualised and renders on-screen and off-screen copies of the same
   * row, so identical entries are collapsed.
   */
  async listNotes(): Promise<WebNoteListRow[]> {
    const frame = await this.appFrame();
    await frame.locator(".note-list-item-container").first().waitFor({ state: "attached", timeout: this.timeoutMs });
    const rows = await frame.evaluate(() =>
      Array.from(document.querySelectorAll(".note-list-item-container")).map((el) => ({
        title: (el.querySelector('[class*="title"]')?.textContent ?? "").trim(),
        snippet: (el.querySelector(".note-list-item-snippet")?.textContent ?? "").trim(),
        folder: (el.querySelector('[class*="folder"]')?.textContent ?? "").trim(),
      })),
    );

    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = `${row.title} ${row.snippet} ${row.folder}`;
      if (seen.has(key) || row.title === "") {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * The client's own record of its last few merges, read out of Apple's
   * built-in diagnostic hook.
   *
   * `installDiagnose` puts `NotesApp.Debug.diagnose()` on the app window; it
   * packages `topoTextManager.mergeTraces` and `icTableManager.mergeTraces`
   * into JSON and appends a download link (a blob URL - it never
   * auto-clicks), which we then fetch back inside the page. Each trace is
   * `{oursBefore, theirsBefore, oursAfter}`, the archives of the client's own
   * copy, the copy it received, and the merge result: the client telling us
   * directly what it did with what we pushed.
   *
   * `CRDTManager` keeps only `maxMergeTraceCount` (3) of these, newest first,
   * and records one *per merge* - a note loaded cold produces none at all,
   * which is itself the signal that no merge happened.
   *
   * Returns undefined when the hook isn't present (an Apple build without it,
   * or a page that hasn't finished launching), so a caller can report that
   * honestly instead of reading silence as "no merge".
   */
  async mergeTraces(): Promise<MergeTraceReport | undefined> {
    const frame = await this.appFrame();
    return (await frame.evaluate(async () => {
      const debug = (window as unknown as { NotesApp?: { Debug?: { diagnose?: () => void } } }).NotesApp?.Debug;
      if (typeof debug?.diagnose !== "function") {
        return undefined;
      }
      debug.diagnose();
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[download$=".json"]'));
      const newest = links[links.length - 1];
      if (!newest) {
        return undefined;
      }
      const text = await (await fetch(newest.href)).text();
      newest.remove();
      return JSON.parse(text) as unknown;
    })) as MergeTraceReport | undefined;
  }

  /**
   * Forces the app's own full reload of one note - `Note.load(id, true)` -
   * which is Apple's own code path for "this record changed under you":
   * `NoteLoader.loadDataIntoDataManager` calls exactly this when a synced
   * Note arrives with a new `ModificationDate` but no body (the zone-sync
   * `desiredKeys` omit `TextDataEncrypted`). The forced load fetches the full
   * record, and the loader then feeds the body to `topoTextManager.load`,
   * whose held-copy branch is the merge.
   *
   * The Note model class isn't a global; it's reached through the app's
   * all-notes collection (`dataManager.__CW__allNotes`) - any instance's
   * `constructor` is the class, and the instance whose `id` contains the
   * record UUID names the primary key to load.
   *
   * Returns the matched primary key, or undefined when the collection is
   * unreachable or no note matches.
   */
  async forceReloadNote(noteId: string): Promise<string | undefined> {
    const frame = await this.appFrame();
    return (await frame.evaluate(async (id: string) => {
      const win = window as unknown as Record<string, unknown>;
      const notesApp = (win.NotesApp ?? {}) as Record<string, unknown>;
      const debug = (notesApp.Debug ?? {}) as Record<string, unknown>;
      const dataManager = (notesApp.dataManager ?? debug.dataManager) as Record<string, unknown> | undefined;
      const raw = (dataManager?.__CW__allNotes ?? dataManager?._allNotesSet) as
        | { forEach?: (cb: (x: unknown) => void) => void }
        | undefined;
      if (!raw || typeof raw.forEach !== "function") {
        return undefined;
      }
      const items: unknown[] = [];
      raw.forEach((x: unknown) => items.push(x));
      for (const item of items) {
        const model = item as { id?: unknown; constructor?: { load?: (k: unknown, force: boolean) => Promise<unknown> } };
        const primaryKey = String(model?.id ?? "");
        if (!primaryKey.toLowerCase().includes(id.toLowerCase())) {
          continue;
        }
        if (typeof model.constructor?.load !== "function") {
          return undefined;
        }
        await model.constructor.load(model.id, true);
        return primaryKey;
      }
      return undefined;
    }, noteId)) as string | undefined;
  }

  async screenshot(file: string): Promise<void> {
    await this.page.screenshot({ path: file });
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}
