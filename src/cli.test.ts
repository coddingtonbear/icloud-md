import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readOwnPackageVersion } from "./version.js";

const execFileAsync = promisify(execFile);

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(packageRoot, "src", "cli.ts");
const tsxBin = path.join(packageRoot, "node_modules", ".bin", "tsx");

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(tsxBin, [cliPath, ...args]);
}

test("--version prints the package version", async () => {
  const { stdout } = await runCli(["--version"]);
  assert.equal(stdout.trim(), readOwnPackageVersion());
});

test("--json --version prints a JSON object on stdout, regardless of flag order", async () => {
  for (const args of [["--json", "--version"], ["--version", "--json"]]) {
    const { stdout } = await runCli(args);
    assert.deepEqual(JSON.parse(stdout), { version: readOwnPackageVersion() });
  }
});

test("the vault-shape flags are reachable from the commands that own them", async () => {
  // `--filename-as-title` is a whole-vault decision, so it lives on `clone`
  // and nowhere else; `--defer-renames` is a per-run choice about what pull
  // does with a rename, so it lives on `pull`.
  const clone = await runCli(["clone", "--help"]);
  assert.match(clone.stdout, /--filename-as-title/);
  // `--account` skips the "which account?" sign-in, so it belongs to clone,
  // the only command that binds a folder to an account in the first place.
  assert.match(clone.stdout, /--account/);

  const pull = await runCli(["pull", "--help"]);
  assert.match(pull.stdout, /--defer-renames/);
  assert.doesNotMatch(pull.stdout, /--filename-as-title/);
});


test("browser-info works without an account in human and JSON modes, before or after global flags", async () => {
  const human = await runCli(["browser-info"]);
  assert.match(human.stdout, /Browser source:/);
  assert.match(human.stdout, /Chromium sandbox: enabled/);
  assert.match(human.stdout, /Playwright:/);
  for (const args of [
    ["--browser-executable", process.execPath, "--json", "browser-info"],
    ["browser-info", "--browser-executable", process.execPath, "--json"],
  ]) {
    const { stdout, stderr } = await execFileAsync(tsxBin, [cliPath, ...args], {
      env: { ...process.env, ICLOUD_MD_BROWSER_EXECUTABLE: "/ignored/environment/browser" },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.source, "option");
    assert.equal(result.executablePath, process.execPath);
    assert.equal(result.exists, true);
    assert.equal(stderr, "");
  }
});
