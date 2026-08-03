/**
 * Vault helpers: create clones of the live account and manipulate the files
 * inside them, in the same way a user with a text editor would.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CloneSummary } from "../src/commands/clone.js";
import type { PullSummary } from "../src/commands/pull.js";
import type { PushResult } from "../src/commands/push.js";
import { EXIT, runCli, type CliResult } from "./cli.js";
import type { ItestConfig } from "./config.js";

export interface VaultOptions {
  filenameAsTitle?: boolean;
}

/**
 * A cloned working copy. `folderDir` is the on-disk directory corresponding
 * to the remote test folder - every fixture file lives there, which is what
 * makes the remote-side containment hold.
 */
export class Vault {
  private constructor(
    readonly dir: string,
    readonly folderName: string,
    readonly titleMode: "filename" | "in-body",
  ) {}

  static async clone(config: ItestConfig, dir: string, options: VaultOptions = {}): Promise<Vault> {
    await mkdir(path.dirname(dir), { recursive: true });
    // `--account` is what makes an unattended run possible: without it, clone
    // opens an interactive sign-in for every new directory.
    //
    // `--non-interactive` is what keeps a *failed* one cheap. A clone that
    // cannot reuse the account's saved sign-in silently would otherwise open
    // a window and wait on a human who isn't there - which on 2026-08-02 cost
    // 5.5 minutes per remaining cloning test once the first one lapsed. There
    // is nobody at this browser, so a refusal is the only useful outcome.
    // (`--account` now reuses the stored session first, so that fallback
    // should not be reached at all; this bounds the cost if it ever is.)
    const args = [
      "clone",
      dir,
      "--account",
      config.dsid,
      "--non-interactive",
      ...(options.filenameAsTitle === true ? ["--filename-as-title"] : []),
    ];
    await runCli<CloneSummary>(args, { timeoutMs: 600_000 });
    return new Vault(dir, config.folder, options.filenameAsTitle === true ? "filename" : "in-body");
  }

  /** The clone directory that mirrors the remote test folder. */
  get folderDir(): string {
    return path.join(this.dir, this.folderName);
  }

  filePath(fileName: string): string {
    return path.join(this.folderDir, fileName);
  }

  async writeNote(fileName: string, contents: string): Promise<void> {
    await mkdir(this.folderDir, { recursive: true });
    await writeFile(this.filePath(fileName), contents, "utf8");
  }

  async readNote(fileName: string): Promise<string> {
    return readFile(this.filePath(fileName), "utf8");
  }

  async noteExists(fileName: string): Promise<boolean> {
    try {
      await readFile(this.filePath(fileName), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async renameNote(from: string, to: string): Promise<void> {
    await rename(this.filePath(from), this.filePath(to));
  }

  async deleteNoteFile(fileName: string): Promise<void> {
    await rm(this.filePath(fileName), { force: true });
  }

  /** Markdown file names inside the test folder, sorted. */
  async listNotes(): Promise<string[]> {
    try {
      return (await readdir(this.folderDir)).filter((name) => name.endsWith(".md")).sort();
    } catch {
      return [];
    }
  }

  /**
   * A path inside the containment folder, vault-root-relative. Every fixture
   * that creates directories must build its path through here: a directory
   * at the vault root would become a *top-level* Notes folder, outside the
   * folder containment is scoped to.
   */
  inFolder(relativePath: string): string {
    return `${this.folderName}/${relativePath}`;
  }

  /** Writes a file at a vault-root-relative path, creating directories as needed. */
  async writeVaultFile(relativePath: string, contents: string): Promise<void> {
    const full = path.join(this.dir, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }

  async readVaultFile(relativePath: string): Promise<string> {
    return readFile(path.join(this.dir, relativePath), "utf8");
  }

  async vaultFileExists(relativePath: string): Promise<boolean> {
    try {
      await readFile(path.join(this.dir, relativePath), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async removeVaultFile(relativePath: string): Promise<void> {
    await rm(path.join(this.dir, relativePath), { force: true });
  }

  /** The `apple-note-id` of a file at a vault-root-relative path. */
  async noteIdOf(relativePath: string): Promise<string> {
    const id = readFrontmatterField(await this.readVaultFile(relativePath), "apple-note-id");
    if (id === undefined) {
      throw new Error(`${relativePath} has no apple-note-id in its frontmatter`);
    }
    return id;
  }

  /**
   * The directory of the first shared area this account has, if any - the
   * only place a "can't create folders in someone else's share" test can
   * point at. Undefined when nothing is shared with the account.
   */
  async firstSharerHomeDir(): Promise<string | undefined> {
    const raw: unknown = JSON.parse(await readFile(path.join(this.dir, ".icloud-md", "state.json"), "utf8"));
    const homes = (raw as { sharerHomes?: Record<string, { dirName?: unknown }> }).sharerHomes ?? {};
    for (const home of Object.values(homes)) {
      if (typeof home.dirName === "string") {
        return home.dirName;
      }
    }
    return undefined;
  }

  /**
   * Finds the note anywhere in the vault by its `apple-note-id`, returning a
   * vault-root-relative path. The whole-vault version of `findByNoteId`,
   * needed once a note can live in a subdirectory the test created.
   */
  async findFileByNoteId(noteId: string): Promise<string | undefined> {
    const walk = async (relativeDir: string): Promise<string | undefined> => {
      const entries = await readdir(path.join(this.dir, relativeDir === "" ? "." : relativeDir), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          const found = await walk(relative);
          if (found !== undefined) {
            return found;
          }
        } else if (entry.name.endsWith(".md")) {
          if (readFrontmatterField(await this.readVaultFile(relative), "apple-note-id") === noteId) {
            return relative;
          }
        }
      }
      return undefined;
    };
    return walk("");
  }

  /**
   * Finds the file holding a given note, by its `apple-note-id`. Necessary
   * because a file name is not stable across clones: in the default mode a
   * fresh clone names each file after the note's *title*, and in
   * filename-as-title mode the name is the title. The note id is the only
   * identifier both sides agree on.
   */
  async findByNoteId(noteId: string): Promise<string | undefined> {
    for (const fileName of await this.listNotes()) {
      if (readFrontmatterField(await this.readNote(fileName), "apple-note-id") === noteId) {
        return fileName;
      }
    }
    return undefined;
  }

  /** The `apple-note-id` a synced file carries in its frontmatter. */
  async noteId(fileName: string): Promise<string> {
    const id = readFrontmatterField(await this.readNote(fileName), "apple-note-id");
    if (id === undefined) {
      throw new Error(`${fileName} has no apple-note-id in its frontmatter`);
    }
    return id;
  }

  push(): Promise<CliResult<PushResult>> {
    return runCli<PushResult>(["push", this.dir]);
  }

  pull(extraArgs: readonly string[] = []): Promise<CliResult<PullSummary>> {
    return runCli<PullSummary>(["pull", this.dir, ...extraArgs]);
  }

  /** `status` exits 3 when changes are pending, which is a normal outcome here. */
  status(): Promise<CliResult<PushResult>> {
    return runCli<PushResult>(["status", this.dir], { allow: [EXIT.changesPending] });
  }

  delete(fileName: string): Promise<CliResult<unknown>> {
    return runCli(["delete", path.join(this.folderName, fileName), this.dir]);
  }
}

/**
 * Reads one frontmatter field. Deliberately a small independent parser rather
 * than importing the project's own frontmatter code: this is test-side
 * observation, and reusing the implementation under test would let a
 * frontmatter bug hide itself.
 */
export function readFrontmatterField(contents: string, field: string): string | undefined {
  if (!contents.startsWith("---\n")) {
    return undefined;
  }
  const end = contents.indexOf("\n---", 3);
  if (end === -1) {
    return undefined;
  }
  for (const line of contents.slice(4, end + 1).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    if (line.slice(0, separator).trim() === field) {
      return line
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

/**
 * The first pipe-table in a markdown file, as rows of cell text, or undefined
 * when there isn't one.
 *
 * Like `readFrontmatterField`, deliberately an independent parser rather than
 * `markdownTable.ts`'s: the tests using this are checking what the table write
 * path produced, and reading it back with the same code that wrote it would
 * let a symmetrical bug pass unnoticed.
 *
 * GFM's alignment row (`| --- | --- |`) is dropped - it carries no content.
 */
export function parseMarkdownTable(contents: string): string[][] | undefined {
  const lines = contents.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith("|"));
  if (first === -1) {
    return undefined;
  }
  const rows: string[][] = [];
  for (let i = first; i < lines.length && (lines[i] ?? "").trimStart().startsWith("|"); i += 1) {
    const cells = (lines[i] ?? "")
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) {
      continue;
    }
    rows.push(cells);
  }
  return rows.length === 0 ? undefined : rows;
}

/**
 * Rewrites the first pipe-table in a markdown file to hold `grid`, leaving
 * every other line alone - how a test makes the edits a user would make in
 * their editor.
 */
export function replaceMarkdownTable(contents: string, grid: readonly (readonly string[])[]): string {
  const lines = contents.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith("|"));
  if (first === -1) {
    throw new Error(`no markdown table to replace in:\n${contents}`);
  }
  let last = first;
  while (last + 1 < lines.length && (lines[last + 1] ?? "").trimStart().startsWith("|")) {
    last += 1;
  }

  const columns = grid[0]?.length ?? 0;
  const rendered = [
    `| ${(grid[0] ?? []).join(" | ")} |`,
    `| ${Array.from({ length: columns }, () => "-").join(" | ")} |`,
    ...grid.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ];
  return [...lines.slice(0, first), ...rendered, ...lines.slice(last + 1)].join("\n");
}

/** The document body with any frontmatter block removed. */
export function stripFrontmatter(contents: string): string {
  if (!contents.startsWith("---\n")) {
    return contents;
  }
  const end = contents.indexOf("\n---", 3);
  if (end === -1) {
    return contents;
  }
  return contents.slice(contents.indexOf("\n", end + 1) + 1);
}
