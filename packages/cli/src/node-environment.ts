import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FetchHttpClient, KitRpcClient, systemClock } from "@vigil-sol/core";
import type { CliEnvironment, OutputStream } from "./environment.js";
import { fixtureMode } from "./fixture-mode.js";
import { FileIdlCache } from "./idl-cache.js";
import type { StateFiles } from "./watch/state-file.js";
import { fetchNotifierHttp } from "./watch/transport.js";

/** The real environment: process streams, live RPC and HTTP clients, the on-disk IDL cache. */
export async function nodeEnvironment(): Promise<CliEnvironment> {
  const env = process.env;
  const fixtures = await fixtureMode(env);
  const shutdown = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      shutdown.abort();
    });
  }
  return {
    clock: fixtures?.clock ?? systemClock,
    createHttp: fixtures?.createHttp ?? (() => new FetchHttpClient()),
    createRpc: fixtures?.createRpc ?? ((url) => new KitRpcClient(url)),
    env,
    files: nodeStateFiles,
    homeDir: homedir(),
    ...(fixtures === undefined ? { idlCache: new FileIdlCache() } : {}),
    notifierHttp: () => fetchNotifierHttp(env),
    shutdown: shutdown.signal,
    sleep: sleep,
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

/** Resolves after `ms`, or as soon as `signal` aborts. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, signal === undefined ? {} : { signal });
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
  }
}

/**
 * The watch state on disk. Writes go to a temporary file in the same directory (0600), are
 * flushed, then renamed over the state file, so a crash leaves either the old or the new state,
 * never half of one. The directory is created 0700: the state lists what a multisig is doing.
 */
export const nodeStateFiles: StateFiles = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  async write(path, text) {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  },
};
