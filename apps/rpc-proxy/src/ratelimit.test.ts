import { describe, expect, it } from "vitest";
import { bindingLimiter, type Limiter, MemoryLimiter } from "./ratelimit.js";

function clock(start = 1_000_000) {
  let now = start;
  return {
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

async function allowed(limiter: Limiter, key: string, times: number): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < times; i += 1) {
    out.push(await limiter.allow(key));
  }
  return out;
}

describe("MemoryLimiter", () => {
  it("allows `limit` requests per key per window, then refuses", async () => {
    const time = clock();
    const limiter = new MemoryLimiter(3, 60_000, 100, time.now);
    expect(await allowed(limiter, "a", 5)).toEqual([true, true, true, false, false]);
    expect(await allowed(limiter, "b", 1)).toEqual([true]);
  });

  it("starts a new window once the old one has passed", async () => {
    const time = clock();
    const limiter = new MemoryLimiter(2, 60_000, 100, time.now);
    expect(await allowed(limiter, "a", 3)).toEqual([true, true, false]);
    time.advance(59_999);
    expect(await allowed(limiter, "a", 1)).toEqual([false]);
    time.advance(1);
    expect(await allowed(limiter, "a", 3)).toEqual([true, true, false]);
  });

  it("never remembers more than maxKeys clients, dropping expired windows first", async () => {
    const time = clock();
    const limiter = new MemoryLimiter(1, 60_000, 3, time.now);
    await allowed(limiter, "old", 2);
    time.advance(60_000);
    await allowed(limiter, "x", 1);
    await allowed(limiter, "y", 1);
    // Full (old, x, y): adding z forgets the expired "old" and keeps x and y limited.
    expect(await allowed(limiter, "z", 1)).toEqual([true]);
    expect(await allowed(limiter, "x", 1)).toEqual([false]);
    expect(await allowed(limiter, "y", 1)).toEqual([false]);
  });

  it("when full of live windows, forgets the oldest (best effort, bounded memory)", async () => {
    const time = clock();
    const limiter = new MemoryLimiter(1, 60_000, 2, time.now);
    await allowed(limiter, "a", 1);
    await allowed(limiter, "b", 1);
    await allowed(limiter, "c", 1);
    // "a" was forgotten, so it gets a fresh window; "c" is still counted.
    expect(await allowed(limiter, "a", 1)).toEqual([true]);
    expect(await allowed(limiter, "c", 1)).toEqual([false]);
  });

  it("allows nothing with a limit of 0", async () => {
    const limiter = new MemoryLimiter(0, 60_000, 10, clock().now);
    expect(await allowed(limiter, "a", 2)).toEqual([false, false]);
  });
});

describe("bindingLimiter", () => {
  const never: Limiter = { allow: () => Promise.reject(new Error("fallback must not be used")) };

  it("follows the binding's answer, keyed by the client", async () => {
    const keys: string[] = [];
    const binding: RateLimit = {
      limit: ({ key }) => {
        keys.push(key);
        return Promise.resolve({ success: key === "ok" });
      },
    };
    const limiter = bindingLimiter(binding, never);
    expect(await limiter.allow("ok")).toBe(true);
    expect(await limiter.allow("over")).toBe(false);
    expect(keys).toEqual(["ok", "over"]);
  });

  it("asks the fallback when the binding throws", async () => {
    const binding: RateLimit = { limit: () => Promise.reject(new Error("down")) };
    const fallback = new MemoryLimiter(1, 60_000, 10, clock().now);
    const limiter = bindingLimiter(binding, fallback);
    expect(await allowed(limiter, "a", 2)).toEqual([true, false]);
  });
});
