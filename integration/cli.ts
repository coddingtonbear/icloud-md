/**
 * Runs the real CLI as a subprocess, the way a user would.
 *
 * Deliberately not importing `runClone`/`runPush`/... directly: the point of
 * this suite is to exercise the shipped entrypoint, so argument parsing, the
 * `--json` contract and exit codes are all under test too. Every call uses
 * `--json`, so stdout is a parseable result and stderr carries the human
 * status chatter.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "./config.js";

const CLI_ENTRY = path.join(REPO_ROOT, "dist", "cli.js");

/** Exit codes the CLI uses (see `src/cli/output.ts` and the `--dry-run` path). */
export const EXIT = {
  ok: 0,
  knownError: 1,
  usageError: 2,
  /** `push --dry-run` / `status` found pending changes. */
  changesPending: 3,
  internalError: 70,
} as const;

export interface CliResult<T> {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout, when the command produced JSON. */
  json: T;
}

export class CliFailedError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`icloud-md ${args.join(" ")} exited ${exitCode}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`);
    this.name = "CliFailedError";
  }
}

export interface RunCliOptions {
  cwd?: string;
  /** Exit codes to accept besides 0 - e.g. `EXIT.changesPending` for `status`. */
  allow?: readonly number[];
  timeoutMs?: number;
}

/**
 * Invokes the built CLI. `--json` goes first because it is a program-level
 * option, and commander only accepts those ahead of the subcommand.
 */
export function runCli<T = unknown>(args: readonly string[], options: RunCliOptions = {}): Promise<CliResult<T>> {
  const allow = new Set<number>([EXIT.ok, ...(options.allow ?? [])]);
  const argv = ["--json", ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...argv], {
      cwd: options.cwd ?? REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`icloud-md ${argv.join(" ")} timed out after ${options.timeoutMs ?? 300_000}ms`));
    }, options.timeoutMs ?? 300_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      if (!allow.has(exitCode)) {
        reject(new CliFailedError(argv, exitCode, stdout, stderr));
        return;
      }

      let json: T;
      try {
        json = JSON.parse(stdout) as T;
      } catch {
        // Some commands legitimately print nothing on stdout.
        json = undefined as T;
      }
      resolve({ exitCode, stdout, stderr, json });
    });
  });
}
