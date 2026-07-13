import { checkAuthentication } from "./cloudkit/setupClient.js";
import { runClone } from "./commands/clone.js";
import { runLogin } from "./commands/login.js";
import { runPull } from "./commands/pull.js";
import { loadSession } from "./session.js";

async function verifyAuth(): Promise<void> {
  const session = await loadSession();
  const result = await checkAuthentication(session);

  if (!result.ok) {
    console.error(`Not authenticated (HTTP ${result.status}): ${result.error}`);
    console.error("The imported session has likely expired - re-export a fresh HAR and re-run import-har.");
    process.exitCode = 1;
    return;
  }

  console.log(`Authenticated as ${result.appleId}${result.fullName ? ` (${result.fullName})` : ""}`);
  console.log(`dsid: ${result.dsid}`);
  console.log(`Notes CloudKit host: ${result.ckdatabasewsUrl ?? "(not reported)"}`);
}

async function clone(targetDirArg: string | undefined): Promise<void> {
  if (!targetDirArg) {
    console.error("Usage: icloud-notes-sync clone <directory>");
    process.exitCode = 1;
    return;
  }
  const session = await loadSession();
  await runClone(session, targetDirArg);
}

async function pull(targetDirArg: string | undefined): Promise<void> {
  const targetDir = targetDirArg ?? ".";
  const session = await loadSession();
  await runPull(session, targetDir);
}

async function login(): Promise<void> {
  await runLogin();
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "login":
      await login();
      return;
    case "verify-auth":
      await verifyAuth();
      return;
    case "clone":
      await clone(rest[0]);
      return;
    case "pull":
      await pull(rest[0]);
      return;
    default:
      console.error(
        "Usage: icloud-notes-sync <command>\n\n" +
          "Commands:\n" +
          "  login                 Sign in with your Apple ID (SRP + trusted-device 2FA); shared across all vaults\n" +
          "  verify-auth           Check whether the stored session is authenticated\n" +
          "  clone <directory>     Fetch all Notes into a fresh local directory\n" +
          "  pull [directory]      Fetch changes since the last clone/pull (defaults to the current directory)",
      );
      process.exitCode = 1;
  }
}

await main();
