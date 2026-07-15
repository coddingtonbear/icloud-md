import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combineUnpublishableReasons,
  formatUnknownEmbedMarker,
  hasUnknownContentMarker,
  UNKNOWN_CONTENT_BANNER,
} from "./unknownContent.js";

test("UNKNOWN_CONTENT_BANNER is a danger admonition", () => {
  assert.match(UNKNOWN_CONTENT_BANNER, /^> \[!danger\] Unparsed content\n/);
});

test("formatUnknownEmbedMarker names the unresolvable type", () => {
  const marker = formatUnknownEmbedMarker("com.apple.notes.table");
  assert.match(marker, /^> \[!danger\] Unparsed content\n/);
  assert.match(marker, /com\.apple\.notes\.table/);
});

test("hasUnknownContentMarker detects the banner", () => {
  assert.equal(hasUnknownContentMarker(`${UNKNOWN_CONTENT_BANNER}Some note text`), true);
});

test("hasUnknownContentMarker detects an embed marker", () => {
  assert.equal(hasUnknownContentMarker(`Some text\n${formatUnknownEmbedMarker("public.url")}more text`), true);
});

test("hasUnknownContentMarker is false for ordinary note text", () => {
  assert.equal(hasUnknownContentMarker("Just a normal note.\n\n> A regular quote, not an admonition."), false);
});

test("combineUnpublishableReasons is undefined when both sources are clean", () => {
  assert.equal(combineUnpublishableReasons(undefined, undefined), undefined);
});

test("combineUnpublishableReasons passes through a single reason unchanged", () => {
  assert.equal(combineUnpublishableReasons("reason A", undefined), "reason A");
  assert.equal(combineUnpublishableReasons(undefined, "reason B"), "reason B");
});

test("combineUnpublishableReasons joins both reasons when both fire", () => {
  assert.equal(combineUnpublishableReasons("reason A", "reason B"), "reason A; reason B");
});
