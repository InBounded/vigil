import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Structurally identical to `IdlCache` in `@vigil/core` (`src/idl/fetch.ts`). Declared here rather
 * than imported because the CLI is not wired to the core package until the CLI phase; see
 * `docs/DECISIONS.md`.
 */
export interface IdlCacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, json: string): Promise<void>;
}

/** `<base58 program>:<sha256 hex>`, the only key shape core produces. Anything else is refused. */
const KEY = /^([1-9A-HJ-NP-Za-km-z]{32,44}):([0-9a-f]{64})$/;
/** Same bound as the decompressed-IDL limit in core: a cache file can never be bigger. */
const MAX_ENTRY_BYTES = 5_000_000;

/**
 * `$XDG_CACHE_HOME/vigil`, or `~/.cache/vigil` when it is unset. Per the XDG Base Directory spec a
 * relative `XDG_CACHE_HOME` is invalid and ignored.
 */
export function defaultCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CACHE_HOME;
  const base =
    xdg !== undefined && xdg !== "" && path.isAbsolute(xdg) ? xdg : path.join(home, ".cache");
  return path.join(base, "vigil");
}

/**
 * IDL cache on disk: one file per key in `<cacheDir>/idl/`, written atomically (temporary file +
 * rename) and readable only by the user. Contents are still validated by core on every read.
 */
export class FileIdlCache implements IdlCacheStore {
  readonly #dir: string;

  constructor(cacheDir: string = defaultCacheDir()) {
    this.#dir = path.join(cacheDir, "idl");
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const file = this.#file(key);
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_ENTRY_BYTES) {
        return undefined;
      }
      return await readFile(file, "utf8");
    } catch {
      return undefined;
    }
  }

  async set(key: string, json: string): Promise<void> {
    const file = this.#file(key);
    if (Buffer.byteLength(json, "utf8") > MAX_ENTRY_BYTES) {
      return;
    }
    await mkdir(this.#dir, { mode: 0o700, recursive: true });
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, json, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  }

  #file(key: string): string {
    const match = KEY.exec(key);
    if (match === null) {
      throw new TypeError("invalid IDL cache key");
    }
    return path.join(this.#dir, `${match[1]}-${match[2]}.json`);
  }
}
