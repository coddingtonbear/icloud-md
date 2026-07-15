import { readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

export interface EnvironmentInfo {
  toolVersion: string;
  nodeVersion: string;
  platform: string;
  osRelease: string;
}

/** Resolves relative to this module rather than `process.cwd()`, so it
 * reports this install's own version regardless of where the CLI is run
 * from - works identically from `src/version.ts` (via tsx) and the compiled
 * `dist/version.js`, since both sit one directory below the package root. */
function readOwnPackageVersion(): string {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const raw = readFileSync(packageJsonPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { version?: unknown }).version !== "string") {
    throw new Error(`${packageJsonPath} is missing a "version" field.`);
  }
  return (parsed as { version: string }).version;
}

/** Gathers the version/environment details a bug report needs to tell one
 * install apart from another - see `runBugReport`. */
export function getEnvironmentInfo(): EnvironmentInfo {
  return {
    toolVersion: readOwnPackageVersion(),
    nodeVersion: process.version,
    platform: os.platform(),
    osRelease: os.release(),
  };
}
