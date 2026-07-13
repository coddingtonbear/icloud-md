import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SESSION_PATH, writeSessionFile } from "../session.js";

interface HarHeader {
  name: string;
  value: string;
}

interface HarRequest {
  url: string;
  headers: HarHeader[];
}

interface HarEntry {
  request: HarRequest;
}

interface HarFile {
  log: {
    entries: HarEntry[];
  };
}

/**
 * Pulls a session out of a HAR capture by using the Cookie header from the LAST
 * request in the file that has one for an icloud.com host, taken verbatim (not
 * merged with any other request). A HAR capture can span more than one login
 * session (e.g. a page reload re-authenticates and rotates tokens); blending
 * cookie values across requests risks combining an old token from one session
 * with a newer one from another, which the server will reject outright. A single
 * real request's Cookie header, taken as-is, is guaranteed to be a coherent
 * snapshot the browser actually sent.
 *
 * Chrome strips cookies from HAR exports by default; the source HAR must be
 * exported with DevTools' "Allow to generate HAR with sensitive data" enabled.
 */
async function main(): Promise<void> {
  const harPathArg = process.argv[2];
  if (!harPathArg) {
    console.error("Usage: npm run import-har -- <path-to-file.har>");
    process.exitCode = 1;
    return;
  }

  const harPath = path.resolve(harPathArg);
  const raw = await readFile(harPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const har = asHarFile(parsed, harPath);

  let cookie: string | undefined;
  let clientId: string | undefined;
  let clientBuildNumber: string | undefined;
  let clientMasteringNumber: string | undefined;

  for (const entry of har.log.entries) {
    let url: URL;
    try {
      url = new URL(entry.request.url);
    } catch {
      continue;
    }
    if (!url.hostname.endsWith("icloud.com")) {
      continue;
    }

    const cookieHeader = entry.request.headers.find((header) => header.name.toLowerCase() === "cookie");
    if (!cookieHeader || cookieHeader.value.length === 0) {
      continue;
    }

    // Last one wins: walk the whole file, keep overwriting with each newer match.
    cookie = cookieHeader.value;
    clientId = url.searchParams.get("clientId") ?? clientId;
    clientBuildNumber = url.searchParams.get("clientBuildNumber") ?? clientBuildNumber;
    clientMasteringNumber = url.searchParams.get("clientMasteringNumber") ?? clientMasteringNumber;
  }

  if (!cookie) {
    console.error(
      "No cookies found for *.icloud.com in that HAR file.\n" +
        'If this was exported from Chrome DevTools, re-export with "Allow to generate HAR with sensitive data" ' +
        "enabled (gear icon in the Network panel) - cookies are stripped from HAR exports by default.",
    );
    process.exitCode = 1;
    return;
  }
  if (!clientId || !clientBuildNumber || !clientMasteringNumber) {
    console.error(
      "Found cookies, but couldn't find clientId/clientBuildNumber/clientMasteringNumber on the same request URL in that HAR file.",
    );
    process.exitCode = 1;
    return;
  }

  const cookieCount = cookie.split(";").filter((pair) => pair.trim().length > 0).length;

  await writeSessionFile({
    cookie,
    clientId,
    clientBuildNumber,
    clientMasteringNumber,
    capturedAt: new Date().toISOString(),
  });

  console.log(`Wrote ${cookieCount} cookies to ${DEFAULT_SESSION_PATH}`);
}

function asHarFile(value: unknown, harPath: string): HarFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("log" in value) ||
    typeof (value as { log: unknown }).log !== "object" ||
    (value as { log: unknown }).log === null
  ) {
    throw new Error(`${harPath} does not look like a HAR file (missing top-level "log" object).`);
  }
  const log = (value as { log: unknown }).log as { entries?: unknown };
  if (!Array.isArray(log.entries)) {
    throw new Error(`${harPath} does not look like a HAR file (missing "log.entries" array).`);
  }
  return value as HarFile;
}

await main();
