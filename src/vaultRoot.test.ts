import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { displayPath, findVaultRoot } from "./vaultRoot.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "vaultroot-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeVault(root: string): Promise<void> {
  await mkdir(path.join(root, ".icloud-notes-sync"), { recursive: true });
  await writeFile(path.join(root, ".icloud-notes-sync", "state.json"), "{}", "utf-8");
}

test("findVaultRoot finds the vault from a nested directory", () =>
  withTempDir(async (dir) => {
    const root = path.join(dir, "vault");
    await makeVault(root);
    const nested = path.join(root, "Recipes", "Desserts");
    await mkdir(nested, { recursive: true });

    assert.equal(await findVaultRoot(nested), root);
    assert.equal(await findVaultRoot(root), root);
  }));

test("findVaultRoot returns undefined outside any vault", () =>
  withTempDir(async (dir) => {
    assert.equal(await findVaultRoot(dir), undefined);
  }));

test("findVaultRoot picks the innermost vault when they nest", () =>
  withTempDir(async (dir) => {
    const outer = path.join(dir, "outer");
    const inner = path.join(outer, "inner");
    await makeVault(outer);
    await makeVault(inner);

    assert.equal(await findVaultRoot(inner), inner);
    assert.equal(await findVaultRoot(outer), outer);
  }));

test("displayPath renders a vault file relative to the current directory", () =>
  withTempDir(async (dir) => {
    const root = path.join(dir, "vault");
    assert.equal(displayPath(root, "Recipes/Pie.md", path.join(root, "Recipes")), "Pie.md");
    assert.equal(
      displayPath(root, "Work/Standup.md", path.join(root, "Recipes")),
      path.join("..", "Work", "Standup.md"),
    );
    assert.equal(displayPath(root, "Pie.md", root), "Pie.md");
  }));
