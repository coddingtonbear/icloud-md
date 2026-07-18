import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combineUnpublishableReasons,
  formatEmbedMarker,
  hasEmbedMarker,
  hasUnknownContentMarker,
  parseEmbedMarkers,
  UNKNOWN_CONTENT_BANNER,
} from "./unknownContent.js";

test("UNKNOWN_CONTENT_BANNER is a danger admonition", () => {
  assert.match(UNKNOWN_CONTENT_BANNER, /^> \[!danger\] Unparsed content\n/);
});

test("hasUnknownContentMarker detects the banner", () => {
  assert.equal(hasUnknownContentMarker(`${UNKNOWN_CONTENT_BANNER}Some note text`), true);
});

test("hasUnknownContentMarker is false for ordinary note text and for embed markers", () => {
  assert.equal(hasUnknownContentMarker("Just a normal note.\n\n> A regular quote, not an admonition."), false);
  assert.equal(hasUnknownContentMarker(formatEmbedMarker({ typeUti: "com.apple.notes.gallery", attachmentIdentifier: "A" })), false);
});

test("formatEmbedMarker carries identity in attributes and a short label as inner text", () => {
  assert.equal(
    formatEmbedMarker({ typeUti: "com.apple.notes.gallery", attachmentIdentifier: "ABC-123" }),
    '<apple-embed type="com.apple.notes.gallery" id="ABC-123">gallery</apple-embed>',
  );
});

test("formatEmbedMarker without an identifier omits the id attribute", () => {
  assert.equal(
    formatEmbedMarker({ typeUti: "com.apple.drawing.2" }),
    '<apple-embed type="com.apple.drawing.2">drawing</apple-embed>',
  );
});

test("formatEmbedMarker with no identity at all is the unknown marker", () => {
  assert.equal(formatEmbedMarker({}), '<apple-embed type="unknown">unidentified embed</apple-embed>');
});

test("formatEmbedMarker falls back to the raw UTI as label for unmapped types", () => {
  assert.equal(
    formatEmbedMarker({ typeUti: "com.example.new-thing", attachmentIdentifier: "X" }),
    '<apple-embed type="com.example.new-thing" id="X">com.example.new-thing</apple-embed>',
  );
});

test("parseEmbedMarkers finds markers in document order with offsets and identity", () => {
  const first = formatEmbedMarker({ typeUti: "com.apple.notes.gallery", attachmentIdentifier: "A-1" });
  const second = formatEmbedMarker({});
  const text = `Intro\n${first}\nMiddle\n${second}\nOutro`;
  const markers = parseEmbedMarkers(text);
  assert.equal(markers.length, 2);
  assert.equal(markers[0]?.text, first);
  assert.equal(markers[0]?.typeUti, "com.apple.notes.gallery");
  assert.equal(markers[0]?.attachmentIdentifier, "A-1");
  assert.equal(text.slice(markers[0]!.start, markers[0]!.end), first);
  assert.equal(markers[1]?.text, second);
  assert.equal(markers[1]?.typeUti, "unknown");
  assert.equal(markers[1]?.attachmentIdentifier, undefined);
});

test("parseEmbedMarkers surfaces a mangled marker rather than skipping it", () => {
  const markers = parseEmbedMarkers('<apple-embed type="com.apple.paper" id="B-2">edited label!</apple-embed>');
  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.attachmentIdentifier, "B-2");
});

test("parseEmbedMarkers finds nothing in ordinary text with html-ish content", () => {
  assert.equal(parseEmbedMarkers("Some <b>bold</b> text and a <u>tag</u>").length, 0);
});

test("hasEmbedMarker detects even a truncated marker opening", () => {
  assert.equal(hasEmbedMarker("pasted <apple-embed type=... junk"), true);
  assert.equal(hasEmbedMarker("plain text"), false);
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
