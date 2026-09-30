import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { diagnosticMessage, redactDiagnostic } from "./errorDiagnostics.js";
import { emitError } from "./cli/output.js";
import { BrowserLaunchError } from "./errors.js";
import { recordLastError } from "./lastError.js";

const sensitive = `Download failed: Site Unavailable
https://user:private-password@proxy.test/archive?signature=private-signature#private-fragment
Authorization: Bearer private-bearer
Cookie: a=private-cookie; b=private-cookie2
Set-Cookie: c=private-cookie3; HttpOnly
{"password":"private-password2","access_token":"private-token"}
X-APPLE-WEBAUTH-TOKEN=private-apple-token
secret='private secret with spaces'
api_key=private-key
scnt: private-scnt
securityCode=private-code
x-apple-id-session-id: private-session`;

test("redacts browser/download credentials, headers, URLs, and labeled secrets", () => {
  const result = redactDiagnostic(sensitive);
  assert.match(result, /Site Unavailable/);
  assert.match(result, /proxy.test\/archive/);
  assert.doesNotMatch(result, /private[- ]/);
});

test("nested error causes are useful and cycle-safe", () => {
  const cause = new Error("underlying error");
  const error = new Error("wrapper", { cause });
  cause.cause = error;
  assert.equal(diagnosticMessage(error), "wrapper\nCaused by: underlying error");
});

test("terminal, JSON, and saved reports retain redacted causes, including unknown failures", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "browser-error-test-"));
  const messages: string[] = [];
  t.mock.method(console, "error", (message: string) => messages.push(message));
  try {
    for (const error of [new BrowserLaunchError("installation", undefined, { cause: new Error(sensitive) }),
      new TypeError("Unknown browser failure", { cause: new Error(sensitive) })]) {
      for (const json of [false, true]) {
        const exitCode = emitError({ json }, error);
        assert.equal(exitCode, error instanceof BrowserLaunchError ? 1 : 70);
        const output = messages.at(-1)!;
        // Human known errors print the hint last; inspect the whole capture.
        assert.match(messages.join("\n"), /Site Unavailable/);
        assert.doesNotMatch(messages.join("\n"), /private[- ]/);
        if (json) assert.match(JSON.parse(output).message, /Site Unavailable/);
      }
      const file = path.join(dir, "last-error.json");
      await recordLastError(error, file);
      const saved = await readFile(file, "utf8");
      assert.match(saved, /Site Unavailable/);
      assert.doesNotMatch(saved, /private[- ]/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
