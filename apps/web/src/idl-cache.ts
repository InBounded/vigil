import type { IdlCache } from "@vigil-sol/core";

/** Total size the cache may use; the oldest-used entries are evicted beyond it. */
export const DEFAULT_IDL_CACHE_BYTES = 20_000_000;

const DB_NAME = "vigil";
const DB_VERSION = 1;
const STORE = "idl";

interface Entry {
  readonly key: string;
  readonly json: string;
  /** UTF-16 code units × 2: what the string occupies in memory, a stable upper-bound proxy. */
  readonly size: number;
  readonly lastUsed: number;
}

export interface IndexedDbIdlCacheOptions {
  /** Injected for tests; defaults to the browser's `indexedDB`. */
  readonly indexedDB?: IDBFactory;
  readonly maxBytes?: number;
  /** Injected clock (ms), for deterministic eviction order in tests. */
  readonly now?: () => number;
}

/**
 * IDL cache in IndexedDB with a total size cap and least-recently-used eviction. Stores only what
 * core has already validated, and core validates it again on every read. Any IndexedDB failure
 * (private browsing, quota, blocked) makes the cache behave as empty rather than break analysis.
 */
export class IndexedDbIdlCache implements IdlCache {
  readonly #factory: IDBFactory | undefined;
  readonly #maxBytes: number;
  readonly #now: () => number;
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbIdlCacheOptions = {}) {
    this.#factory = options.indexedDB ?? globalThis.indexedDB;
    this.#maxBytes = options.maxBytes ?? DEFAULT_IDL_CACHE_BYTES;
    this.#now = options.now ?? Date.now;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const db = await this.#open();
      const entry = await request<Entry | undefined>(
        db.transaction(STORE, "readonly").objectStore(STORE).get(key),
      );
      if (entry === undefined) {
        return undefined;
      }
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      await request(store.put({ ...entry, lastUsed: this.#now() }));
      return entry.json;
    } catch {
      return undefined;
    }
  }

  async set(key: string, json: string): Promise<void> {
    const size = json.length * 2;
    if (size > this.#maxBytes) {
      return;
    }
    try {
      const db = await this.#open();
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const entry: Entry = { json, key, lastUsed: this.#now(), size };
      await request(store.put(entry));
      await this.#evict(db);
    } catch {
      // A cache that cannot be written is simply a cache miss next time.
    }
  }

  async #evict(db: IDBDatabase): Promise<void> {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const entries = await request<Entry[]>(store.getAll());
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const byAge = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of byAge) {
      if (total <= this.#maxBytes) {
        break;
      }
      await request(store.delete(entry.key));
      total -= entry.size;
    }
  }

  /**
   * Deletes the whole cache database ("Delete all local data"). Closes this instance's connection
   * first: an open connection would block the deletion. Resolves `false` if the browser refused.
   */
  async deleteAll(): Promise<boolean> {
    const factory = this.#factory;
    if (factory === undefined) {
      return true;
    }
    const pending = this.#db;
    this.#db = undefined;
    try {
      (await pending)?.close();
    } catch {
      // The database never opened: nothing to close.
    }
    return new Promise<boolean>((resolve) => {
      try {
        const deletion = factory.deleteDatabase(DB_NAME);
        deletion.onsuccess = () => resolve(true);
        deletion.onerror = () => resolve(false);
        deletion.onblocked = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  #open(): Promise<IDBDatabase> {
    const factory = this.#factory;
    if (factory === undefined) {
      return Promise.reject(new Error("IndexedDB is not available"));
    }
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(STORE, { keyPath: "key" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
      open.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    return this.#db;
  }
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}
