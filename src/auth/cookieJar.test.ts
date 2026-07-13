import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSetCookies } from "./cookieJar.js";

test("starts a fresh cookie header from Set-Cookie responses", () => {
  const result = mergeSetCookies("", ["aasp=abc123; Path=/; Secure; HttpOnly"]);
  assert.equal(result, "aasp=abc123");
});

test("merges multiple Set-Cookie headers into one Cookie header", () => {
  const result = mergeSetCookies("", [
    "aasp=abc123; Path=/; Secure; HttpOnly",
    "X-APPLE-WEBAUTH-TOKEN=xyz789; Path=/; Domain=.icloud.com; Secure",
  ]);
  assert.equal(result, "aasp=abc123; X-APPLE-WEBAUTH-TOKEN=xyz789");
});

test("a later Set-Cookie for the same name overwrites the earlier value", () => {
  const result = mergeSetCookies("aasp=old", ["aasp=new; Path=/"]);
  assert.equal(result, "aasp=new");
});

test("preserves existing cookies not touched by the new Set-Cookie headers", () => {
  const result = mergeSetCookies("aasp=abc123; other=untouched", ["scnt=updated; Path=/"]);
  assert.equal(result, "aasp=abc123; other=untouched; scnt=updated");
});

test("empty existing header and empty Set-Cookie list yields an empty string", () => {
  assert.equal(mergeSetCookies("", []), "");
});
