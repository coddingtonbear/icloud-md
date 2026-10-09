import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readOwnPackageVersion } from "./version.js";

const execFileAsync = promisify(execFile);

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(packageRoot, "src", "cli.ts");
const tsxBin = path.join(packageRoot, "node_modules", ".bin", "tsx");

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(tsxBin, [cliPath, ...args], { env: { ...process.env, ...env } });
}

function failsWith(pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    const { code, stderr } = error as { code: number; stderr: string };
    assert.equal(code, 1);
    assert.match(stderr, pattern);
    return true;
  };
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

test("--browser-executable rejects a non-absolute path before the command runs", async () => {
  await assert.rejects(
    runCli(["--browser-executable", "chromium", "verify-auth", "/nonexistent"]),
    failsWith(/must be an absolute path/),
  );
});

test("an inherited ICLOUD_MD_BROWSER_EXECUTABLE is validated up front just like the flag", async () => {
  await assert.rejects(
    runCli(["verify-auth", "/nonexistent"], { ICLOUD_MD_BROWSER_EXECUTABLE: "chromium" }),
    failsWith(/must be an absolute path/),
  );
  await assert.rejects(
    runCli(["verify-auth", "/nonexistent"], { ICLOUD_MD_BROWSER_EXECUTABLE: "/nonexistent/chromium" }),
    failsWith(/\/nonexistent\/chromium does not exist/),
  );
});

test("--browser-executable fails fast on a path with nothing runnable at it, in either argument position", async () => {
  for (const args of [
    ["--browser-executable", "/nonexistent/chromium", "verify-auth", "/nonexistent"],
    ["verify-auth", "--browser-executable", "/nonexistent/chromium", "/nonexistent"],
  ]) {
    await assert.rejects(runCli(args), failsWith(/\/nonexistent\/chromium does not exist/));
  }
});

test("--browser-executable accepts a real executable and lets the command run", async () => {
  // The command is pointed at an empty directory so it fails for its own
  // reason - "not a clone" - which is only reachable once the hook has
  // accepted the executable. Node's own binary stands in for a browser;
  // nothing is launched before that failure.
  const dir = await mkdtemp(path.join(tmpdir(), "icloud-md-cli-"));
  try {
    await assert.rejects(
      runCli(["--browser-executable", process.execPath, "verify-auth", dir]),
      failsWith(/doesn.t look like a cloned notes directory/),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install-browser is a listed command", async () => {
  const { stdout } = await runCli(["install-browser", "--help"]);
  assert.match(stdout, /bundled sign-in browser/);
});
