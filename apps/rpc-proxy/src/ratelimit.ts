/** Whether one more request from `key` may go through now. */
export interface Limiter {
  allow(key: string): Promise<boolean>;
}

/** Fallback limit: requests per client IP per window, per isolate. */
export const FALLBACK_LIMIT = 100;
export const FALLBACK_WINDOW_MS = 60_000;
/** Most clients the fallback remembers at once; beyond that it forgets the oldest windows. */
export const FALLBACK_MAX_KEYS = 10_000;

/**
 * Cloudflare's rate limiting binding. It counts per Cloudflare location and is "permissive,
 * eventually consistent" by design. If the call itself fails, `fallback` decides instead, so an
 * outage of the binding neither blocks every user nor lifts the limit.
 */
export function bindingLimiter(binding: RateLimit, fallback: Limiter): Limiter {
  return {
    async allow(key) {
      try {
        const outcome = await binding.limit({ key });
        return outcome.success;
      } catch {
        return fallback.allow(key);
      }
    },
  };
}

/**
 * Best-effort fixed-window limit kept in the memory of one Worker isolate. Isolates are not
 * shared (several may serve the same client, and they are recycled at any time), so this only
 * slows a single client down; it is not an accurate count. Used when the binding is absent.
 */
export class MemoryLimiter implements Limiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;

  constructor(
    limit = FALLBACK_LIMIT,
    windowMs = FALLBACK_WINDOW_MS,
    maxKeys = FALLBACK_MAX_KEYS,
    now: () => number = Date.now,
  ) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
    this.#now = now;
  }

  async allow(key: string): Promise<boolean> {
    const now = this.#now();
    const window = this.#windows.get(key);
    if (window !== undefined && now - window.start < this.#windowMs) {
      window.count += 1;
      return window.count <= this.#limit;
    }
    this.#windows.delete(key);
    if (this.#windows.size >= this.#maxKeys) {
      this.#forgetExpired(now);
    }
    this.#windows.set(key, { count: 1, start: now });
    return this.#limit >= 1;
  }

  #forgetExpired(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) {
        this.#windows.delete(key);
      }
    }
    // Still full: drop the oldest entries (a Map iterates in insertion order).
    for (const key of this.#windows.keys()) {
      if (this.#windows.size < this.#maxKeys) {
        break;
      }
      this.#windows.delete(key);
    }
  }
}
