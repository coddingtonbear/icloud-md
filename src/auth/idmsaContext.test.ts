import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_IDMSA_CONTEXT, updateIdmsaContext } from "./idmsaContext.js";

test("captures scnt from a response header", () => {
  const headers = new Headers({ scnt: "some-scnt-value" });
  const updated = updateIdmsaContext(EMPTY_IDMSA_CONTEXT, headers);
  assert.equal(updated.scnt, "some-scnt-value");
});

test("keeps the previous scnt if the response doesn't include one", () => {
  const context = { ...EMPTY_IDMSA_CONTEXT, scnt: "existing-scnt" };
  const updated = updateIdmsaContext(context, new Headers());
  assert.equal(updated.scnt, "existing-scnt");
});

test("folds Set-Cookie headers into the cookie string", () => {
  const headers = new Headers();
  headers.append("set-cookie", "aasp=abc123; Path=/; Secure");
  const updated = updateIdmsaContext(EMPTY_IDMSA_CONTEXT, headers);
  assert.equal(updated.cookie, "aasp=abc123");
});

test("does not touch sessionId - that's set explicitly elsewhere", () => {
  const context = { ...EMPTY_IDMSA_CONTEXT, sessionId: "existing-session-id" };
  const updated = updateIdmsaContext(context, new Headers({ scnt: "x" }));
  assert.equal(updated.sessionId, "existing-session-id");
});
