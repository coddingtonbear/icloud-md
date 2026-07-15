import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendDebugLog } from "../debugLog.js";
import { recordLastError } from "../lastError.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { parseSinceDuration, runBugReport, DISCLOSURE_WARNING } from "./bugReport.js";

async function withTempDirs(
  run: (paths: { targetDir: string; debugLogPath: string; lastErrorPath: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "bugreport-test-"));
  try {
    await run({
      targetDir: dir,
      debugLogPath: path.join(dir, "config", "debug.log"),
      lastErrorPath: path.join(dir, "config", "last-error.json"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STATE: CloneState = {
  syncToken: "token",
  account: { appleId: "person@example.com", dsid: "123" },
  notes: {
    REC1: { file: "Test Note.md", recordChangeTag: "1a", modificationDate: 100 },
  },
};

test("bundles environment info, last error, state, and in-range log entries into one file", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await writeCloneState(targetDir, STATE);
    await recordLastError(new Error("push failed"), lastErrorPath);
    await writeFile(
      debugLogPath,
      [
        JSON.stringify({ timestamp: "2020-01-01T00:00:00.000Z", note: "tooOld" }),
        JSON.stringify({ timestamp: "2026-07-14T12:30:00.000Z", note: "inRange" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const summary = await runBugReport(targetDir, new Date("2026-07-14T12:00:00.000Z"), { debugLogPath, lastErrorPath });

    assert.equal(summary.logEntryCount, 1);
    const contents = await readFile(summary.outputPath, "utf-8");
    assert.match(contents, /# icloud-notes-sync bug report/);
    assert.match(contents, /push failed/);
    assert.match(contents, /"appleId": "person@example\.com"/);
    assert.match(contents, /"note": "inRange"/);
    assert.doesNotMatch(contents, /tooOld/);
  }));

test("handles a directory with no state.json and no recorded error gracefully", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });

    const contents = await readFile(summary.outputPath, "utf-8");
    assert.match(contents, /No failure has been recorded/);
    assert.match(contents, /No `\.icloud-notes-sync\/state\.json` found/);
    assert.match(contents, /No debug log entries fall within this time range\./);
  }));

test("prints the disclosure warning before writing the bundle", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(warnings.includes(DISCLOSURE_WARNING));
  }));

test("writes the bundle into the target directory", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await appendDebugLog({ note: "irrelevant" }, debugLogPath);

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });

    assert.equal(path.dirname(summary.outputPath), targetDir);
    assert.match(path.basename(summary.outputPath), /^icloud-notes-bug-report-.*\.md$/);
  }));

test("reports a corrupt state.json instead of crashing", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await mkdir(path.join(targetDir, ".icloud-notes-sync"), { recursive: true });
    await writeFile(path.join(targetDir, ".icloud-notes-sync", "state.json"), "{}", "utf-8");

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });

    const contents = await readFile(summary.outputPath, "utf-8");
    assert.match(contents, /exists but couldn't be read/);
    assert.match(contents, /does not look like a valid state file/);
  }));

test("parseSinceDuration parses minutes, hours, and days into a past Date", () => {
  const now = Date.now();

  const thirtyMinutes = parseSinceDuration("30m");
  assert.ok(thirtyMinutes);
  assert.ok(Math.abs(now - thirtyMinutes.getTime() - 30 * 60_000) < 1000);

  const sixHours = parseSinceDuration("6h");
  assert.ok(sixHours);
  assert.ok(Math.abs(now - sixHours.getTime() - 6 * 3_600_000) < 1000);

  const twoDays = parseSinceDuration("2d");
  assert.ok(twoDays);
  assert.ok(Math.abs(now - twoDays.getTime() - 2 * 86_400_000) < 1000);
});

test("parseSinceDuration rejects malformed or unsupported input", () => {
  assert.equal(parseSinceDuration(""), undefined);
  assert.equal(parseSinceDuration("since yesterday"), undefined);
  assert.equal(parseSinceDuration("1"), undefined);
  assert.equal(parseSinceDuration("m"), undefined);
  assert.equal(parseSinceDuration("1w"), undefined);
  assert.equal(parseSinceDuration("-1h"), undefined);
});
