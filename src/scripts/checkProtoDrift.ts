/**
 * Regenerates `src/notes/gen/notestore_pb.ts` into a temp directory and
 * diffs it against the committed copy - fails (non-zero exit) if they
 * differ, so a `.proto` edit without a matching `npm run proto:generate`
 * can't land silently. Permanent guard (not just a migration-time check).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const COMMITTED_PATH = path.join(REPO_ROOT, "src", "notes", "gen", "notestore_pb.ts");

async function main(): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "icloud-notes-sync-proto-check-"));
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

    const [committed, fresh] = await Promise.all([
      readFile(COMMITTED_PATH, "utf-8"),
      readFile(path.join(tmpDir, "notestore_pb.ts"), "utf-8"),
    ]);

    if (committed !== fresh) {
      console.error(
        "src/notes/gen/notestore_pb.ts is out of date with proto/notestore.proto.\n" +
          "Run `npm run proto:generate` and commit the result.",
      );
      process.exitCode = 1;
      return;
    }
    console.log("src/notes/gen/notestore_pb.ts is up to date.");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();
