import { test } from "node:test";
import assert from "node:assert/strict";
import { getEnvironmentInfo } from "./version.js";

test("getEnvironmentInfo reports this install's package version and the running environment", () => {
  const info = getEnvironmentInfo();

  assert.match(info.toolVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(info.nodeVersion, process.version);
  assert.equal(info.platform, process.platform);
  assert.ok(info.osRelease.length > 0);
});
