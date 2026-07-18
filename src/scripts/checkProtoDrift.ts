/**
 * Regenerates the `src/notes/gen/*_pb.ts` files into a temp directory and
 * diffs each against the committed copy - fails (non-zero exit) if any
 * differ (or a committed file has no freshly-generated counterpart, or vice
 * versa), so a `.proto` edit without a matching `npm run proto:generate`
 * can't land silently. Permanent guard (not just a migration-time check).
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const COMMITTED_DIR = path.join(REPO_ROOT, "src", "notes", "gen");

async function generatedFileNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith("_pb.ts")).sort();
}

async function main(): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "icloud-md-proto-check-"));
  try {
    const template = {
      version: "v2",
      plugins: [
        {
          local: "protoc-gen-es",
          out: tmpDir,
          opt: ["target=ts", "import_extension=js"],
        },
      ],
    };
    const templatePath = path.join(tmpDir, "buf.gen.check.json");
    await writeFile(templatePath, JSON.stringify(template));

    await execFileAsync("npx", ["buf", "generate", "--template", templatePath], { cwd: REPO_ROOT });

    const [committedNames, freshNames] = await Promise.all([generatedFileNames(COMMITTED_DIR), generatedFileNames(tmpDir)]);

    const stale: string[] = [];
    for (const name of new Set([...committedNames, ...freshNames])) {
      const [committed, fresh] = await Promise.all([
        readFile(path.join(COMMITTED_DIR, name), "utf-8").catch(() => undefined),
        readFile(path.join(tmpDir, name), "utf-8").catch(() => undefined),
      ]);
      if (committed !== fresh) {
        stale.push(name);
      }
    }

    if (stale.length > 0) {
      console.error(
        `src/notes/gen is out of date with proto/ (${stale.join(", ")}).\n` + "Run `npm run proto:generate` and commit the result.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`src/notes/gen is up to date (${committedNames.join(", ")}).`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();
