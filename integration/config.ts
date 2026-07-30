/**
 * Configuration and the master gate for the live integration suite.
 *
 * These tests talk to a real iCloud account and perform real writes, so
 * nothing here runs unless it is switched on deliberately: `npm test` stays
 * hermetic and offline.
 */

import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "../src/configDir.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The env var that switches the live suite on. */
export const ENABLE_VAR = "ICLOUD_MD_ITEST";

/**
 * Name of the remote Notes folder that contains every fixture this suite
 * creates. Containment rests on this: the suite only ever writes inside this
 * folder, and only ever deletes records that are both inside it *and* carry a
 * run prefix (see `containment.ts`).
 */
export const DEFAULT_TEST_FOLDER = "icloud-md-itest";

export interface ItestConfig {
  /** Apple account (dsid) whose trusted browser profile and session are used. */
  dsid: string;
  /** Remote folder holding all fixtures. */
  folder: string;
  /** Scratch directory for the clones a run creates. */
  workRoot: string;
  /** Run the web oracle with a visible browser window. */
  headless: boolean;
  /** Keep clone directories after a run instead of deleting them. */
  keepArtifacts: boolean;
}

export class ItestDisabledError extends Error {}
export class ItestConfigError extends Error {}

/**
 * The single dsid this machine has signed in, or the one named by
 * `ICLOUD_MD_ITEST_DSID`. Discovery keeps the common one-account case
 * zero-config while refusing to guess when it would be a coin flip.
 */
async function resolveDsid(): Promise<string> {
  const fromEnv = process.env.ICLOUD_MD_ITEST_DSID;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }

  const accountsRoot = path.join(CONFIG_DIR, "accounts");
  let entries: string[];
  try {
    entries = (await readdir(accountsRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    throw new ItestConfigError(
      `No accounts found under ${accountsRoot}. Sign in once with "icloud-md clone <dir>" before running the integration suite.`,
    );
  }

  if (entries.length === 1) {
    return entries[0]!;
  }
  if (entries.length === 0) {
    throw new ItestConfigError(
      `No accounts found under ${accountsRoot}. Sign in once with "icloud-md clone <dir>" before running the integration suite.`,
    );
  }
  throw new ItestConfigError(
    `${entries.length} accounts are signed in on this machine (${entries.join(", ")}). ` +
      "Set ICLOUD_MD_ITEST_DSID to the one the suite should use.",
  );
}

/** The Apple ID behind a dsid, for the confirmation banner a run prints. */
export async function appleIdForDsid(dsid: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(CONFIG_DIR, "accounts", dsid, "meta.json"), "utf8"));
    const appleId = (raw as { appleId?: unknown }).appleId;
    return typeof appleId === "string" ? appleId : undefined;
  } catch {
    return undefined;
  }
}

/** Throws unless the suite has been explicitly enabled. */
export function assertEnabled(): void {
  if (process.env[ENABLE_VAR] !== "1") {
    throw new ItestDisabledError(
      `The live integration suite is off. It performs real writes against a real iCloud account; ` +
        `set ${ENABLE_VAR}=1 to run it (see integration/README.md).`,
    );
  }
}

export async function loadConfig(): Promise<ItestConfig> {
  assertEnabled();
  return {
    dsid: await resolveDsid(),
    folder: process.env.ICLOUD_MD_ITEST_FOLDER ?? DEFAULT_TEST_FOLDER,
    workRoot: process.env.ICLOUD_MD_ITEST_WORKROOT ?? path.join(os.tmpdir(), "icloud-md-itest"),
    headless: process.env.ICLOUD_MD_ITEST_HEADED !== "1",
    keepArtifacts: process.env.ICLOUD_MD_ITEST_KEEP === "1",
  };
}
