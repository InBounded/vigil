import { readFile } from "node:fs/promises";
import { FetchHttpClient, KitRpcClient, systemClock } from "@vigil-sol/core";
import type { CliEnvironment, OutputStream } from "./environment.js";
import { fixtureMode } from "./fixture-mode.js";
import { FileIdlCache } from "./idl-cache.js";

/** The real environment: process streams, live RPC and HTTP clients, the on-disk IDL cache. */
export async function nodeEnvironment(): Promise<CliEnvironment> {
  const env = process.env;
  const fixtures = await fixtureMode(env);
  return {
    clock: fixtures?.clock ?? systemClock,
    createHttp: fixtures?.createHttp ?? (() => new FetchHttpClient()),
    createRpc: fixtures?.createRpc ?? ((url) => new KitRpcClient(url)),
    env,
    ...(fixtures === undefined ? { idlCache: new FileIdlCache() } : {}),
    readStdin: (maxBytes) => readStdin(maxBytes),
    stderr: stream(process.stderr),
    stdout: stream(process.stdout),
    version: await packageVersion(),
  };
}

/**
 * A process stream for the CLI. When the reader goes away (`vigil … | head`), writes stop quietly
 * instead of crashing with EPIPE; the command still finishes and exits with its own code.
 */
function stream(target: NodeJS.WriteStream): OutputStream {
  let closed = false;
  target.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
      throw error;
    }
    closed = true;
  });
  return {
    get columns() {
      return target.columns;
    },
    isTTY: target.isTTY === true,
    write: (text) => {
      if (!closed) {
        target.write(text);
      }
    },
  };
}

async function readStdin(maxBytes: number): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw new Error("standard input is a terminal, not a pipe");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error(`more than ${maxBytes} bytes, larger than any transaction`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `dist/` and `src/` both sit directly under the package root. */
async function packageVersion(): Promise<string> {
  const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const version = (JSON.parse(text) as { version?: unknown }).version;
  return typeof version === "string" ? version : "unknown";
}
