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
  topoTextMergeTraces: MergeTrace[];
  tableMergeTraces: MergeTrace[];
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
    return this.copyOpenNote(noteId);
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

  async screenshot(file: string): Promise<void> {
    await this.page.screenshot({ path: file });
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}
