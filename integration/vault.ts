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
    const args = [
      "clone",
      dir,
      "--account",
      config.dsid,
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
