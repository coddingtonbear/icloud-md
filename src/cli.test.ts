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
