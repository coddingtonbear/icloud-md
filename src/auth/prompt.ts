import { createInterface } from "node:readline/promises";

/** Visible line prompt (Apple ID, 2FA code). */
export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Hidden/non-echoed line prompt (password) - fully silent, no asterisks, like
 * `sudo`. Requires a real TTY (throws rather than hanging or silently
 * echoing under piped/CI input). Hand-rolled over readline, which has no
 * first-class masked-input support.
 */
export async function promptHiddenLine(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error("Interactive login requires a TTY (stdin is not a terminal).");
  }

  process.stdout.write(question);

  return new Promise<string>((resolve, reject) => {
    const bytes: number[] = [];

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
    };

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) {
          cleanup();
          process.stdout.write("\n");
          resolve(Buffer.from(bytes).toString("utf8"));
          return;
        }
        if (byte === 0x03) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Login cancelled."));
          return;
        }
        if (byte === 0x08 || byte === 0x7f) {
          bytes.pop();
          continue;
        }
        bytes.push(byte);
      }
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}
