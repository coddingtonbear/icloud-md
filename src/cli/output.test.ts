import { test } from "node:test";
import assert from "node:assert/strict";
import { IcloudNotesSyncError } from "../errors.js";
import { createOutputContext, emitError, emitResult, emitUsageError, makeStatusSink } from "./output.js";

class TestKnownError extends IcloudNotesSyncError {
  constructor(hint?: string) {
    super("something expected went wrong", hint !== undefined ? { hint } : {});
  }
}

function captureConsole(): {
  logLines: string[];
  errorLines: string[];
  restore: () => void;
} {
  const logLines: string[] = [];
  const errorLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map(String).join(" "));
  };
  return {
    logLines,
    errorLines,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

test("emitResult calls renderHuman and prints nothing itself in human mode", () => {
  const { logLines, restore } = captureConsole();
  try {
    let rendered: number | undefined;
    emitResult(createOutputContext(false), 42, (n) => {
      rendered = n;
    });
    assert.equal(rendered, 42);
    assert.deepEqual(logLines, []);
  } finally {
    restore();
  }
});

test("emitResult prints the result as JSON to stdout in json mode, ignoring renderHuman", () => {
  const { logLines, restore } = captureConsole();
  try {
    let renderHumanCalled = false;
    emitResult(createOutputContext(true), { a: 1, b: "two" }, () => {
      renderHumanCalled = true;
    });
    assert.equal(renderHumanCalled, false);
    assert.equal(logLines.length, 1);
    assert.deepEqual(JSON.parse(logLines[0] ?? ""), { a: 1, b: "two" });
  } finally {
    restore();
  }
});

test("makeStatusSink routes to stdout in human mode and stderr in json mode", () => {
  const { logLines, errorLines, restore } = captureConsole();
  try {
    makeStatusSink(createOutputContext(false))("human status");
    makeStatusSink(createOutputContext(true))("json status");
    assert.deepEqual(logLines, ["human status"]);
    assert.deepEqual(errorLines, ["json status"]);
  } finally {
    restore();
  }
});

test("emitError reports a known IcloudNotesSyncError as red text + hint on stderr in human mode and returns 1", () => {
  const { errorLines, restore } = captureConsole();
  try {
    const code = emitError(createOutputContext(false), new TestKnownError("try this instead"));
    assert.equal(code, 1);
    assert.equal(errorLines.length, 2);
    assert.match(errorLines[0] ?? "", /something expected went wrong/);
    assert.match(errorLines[1] ?? "", /try this instead/);
  } finally {
    restore();
  }
});

test("emitError reports a known IcloudNotesSyncError as a structured JSON object on stderr in json mode and returns 1", () => {
  const { errorLines, restore } = captureConsole();
  try {
    const code = emitError(createOutputContext(true), new TestKnownError("try this instead"));
    assert.equal(code, 1);
    assert.equal(errorLines.length, 1);
    const payload = JSON.parse(errorLines[0] ?? "");
    assert.equal(payload.error, "TestKnownError");
    assert.equal(payload.message, "something expected went wrong");
    assert.equal(payload.hint, "try this instead");
    assert.equal(payload.exitCode, 1);
  } finally {
    restore();
  }
});

test("emitError omits hint from the json payload when the error has none", () => {
  const { errorLines, restore } = captureConsole();
  try {
    emitError(createOutputContext(true), new TestKnownError());
    const payload = JSON.parse(errorLines[0] ?? "");
    assert.equal("hint" in payload, false);
  } finally {
    restore();
  }
});

test("emitError treats anything else as an internal error, preserving the stack, and returns 70", () => {
  const { errorLines, restore } = captureConsole();
  try {
    const code = emitError(createOutputContext(false), new Error("a genuine bug"));
    assert.equal(code, 70);
    assert.equal(errorLines.length, 1);
    assert.match(errorLines[0] ?? "", /a genuine bug/);
  } finally {
    restore();
  }
});

test("emitError reports an internal error as structured JSON with a stack in json mode and returns 70", () => {
  const { errorLines, restore } = captureConsole();
  try {
    const code = emitError(createOutputContext(true), new Error("a genuine bug"));
    assert.equal(code, 70);
    const payload = JSON.parse(errorLines[0] ?? "");
    assert.equal(payload.error, "InternalError");
    assert.equal(payload.message, "a genuine bug");
    assert.equal(payload.exitCode, 70);
    assert.match(payload.stack, /a genuine bug/);
  } finally {
    restore();
  }
});

test("emitError handles a thrown non-Error value as an internal error", () => {
  const { errorLines, restore } = captureConsole();
  try {
    const code = emitError(createOutputContext(true), "just a string");
    assert.equal(code, 70);
    const payload = JSON.parse(errorLines[0] ?? "");
    assert.equal(payload.error, "InternalError");
    assert.equal(payload.message, "just a string");
    assert.equal("stack" in payload, false);
  } finally {
    restore();
  }
});

test("emitUsageError prints nothing in human mode (commander already wrote the message) but still returns 2", () => {
  const { errorLines, restore } = captureConsole();
  try {
    const code = emitUsageError(createOutputContext(false), "unknown option '--nope'");
    assert.equal(code, 2);
    assert.deepEqual(errorLines, []);
  } finally {
    restore();
  }
});

test("emitUsageError prints a structured JSON object in json mode and returns 2", () => {
  const { errorLines, restore } = captureConsole();
  try {
    const code = emitUsageError(createOutputContext(true), "unknown option '--nope'");
    assert.equal(code, 2);
    assert.equal(errorLines.length, 1);
    const payload = JSON.parse(errorLines[0] ?? "");
    assert.deepEqual(payload, { error: "UsageError", message: "unknown option '--nope'", exitCode: 2 });
  } finally {
    restore();
  }
});
