import type { Clock, HttpClient, IdlCache, RpcClient } from "@vigil-sol/core";
import type { StateFiles } from "./watch/state-file.js";
import type { NotifierHttp } from "./watch/transport.js";

/** Where the CLI writes. Injected so tests capture output and decide what is a terminal. */
export interface OutputStream {
  write(text: string): void;
  readonly isTTY: boolean;
  /** Terminal width, when `isTTY`. */
  readonly columns?: number;
}

/**
 * Everything the CLI reads from or writes to the outside world. `bin.ts` builds the real one;
 * tests build their own, so every command runs in-process against fixtures.
 */
export interface CliEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  /** Reads all of standard input, refusing more than `maxBytes`. */
  readStdin(maxBytes: number): Promise<string>;
  readonly clock: Clock;
  /** A client for this RPC URL. The URL itself must never reach any output. */
  createRpc(url: string): RpcClient;
  /** The HTTP client for the program-verification API. */
  createHttp(): HttpClient;
  readonly idlCache?: IdlCache;
  readonly version: string;
  /** `vigil watch`: its state file. */
  readonly files: StateFiles;
  /** The user's home directory, for the default state path. */
  readonly homeDir: string | undefined;
  /** `vigil watch`: how alerts reach Discord and Telegram. */
  notifierHttp(): NotifierHttp;
  /** Waits, returning early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Aborted on SIGINT / SIGTERM, so `vigil watch` stops between cycles. */
  readonly shutdown?: AbortSignal;
}
