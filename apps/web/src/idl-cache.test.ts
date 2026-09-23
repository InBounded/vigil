import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbIdlCache } from "./idl-cache.js";

const key = (n: number) =>
  `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD:${n.toString(16).padStart(64, "0")}`;

function clock() {
  let t = 0;
  return () => ++t;
}

describe("IndexedDbIdlCache", () => {
  it("stores and returns entries", async () => {
    const cache = new IndexedDbIdlCache({ indexedDB: new IDBFactory() });
    expect(await cache.get(key(1))).toBeUndefined();
    await cache.set(key(1), '{"instructions":[]}');
    expect(await cache.get(key(1))).toBe('{"instructions":[]}');
  });

  it("persists across instances sharing the same database", async () => {
    const factory = new IDBFactory();
    await new IndexedDbIdlCache({ indexedDB: factory }).set(key(1), "{}");
    expect(await new IndexedDbIdlCache({ indexedDB: factory }).get(key(1))).toBe("{}");
  });

  it("keeps the total under the cap by evicting the least recently used entries", async () => {
    // Each 100-character entry counts as 200 bytes; the cap fits two.
    const cache = new IndexedDbIdlCache({
      indexedDB: new IDBFactory(),
      maxBytes: 450,
      now: clock(),
    });
    await cache.set(key(1), "a".repeat(100));
    await cache.set(key(2), "b".repeat(100));
    expect(await cache.get(key(1))).toBe("a".repeat(100)); // key 1 is now the most recently used
    await cache.set(key(3), "c".repeat(100));
    expect(await cache.get(key(2))).toBeUndefined();
    expect(await cache.get(key(1))).toBe("a".repeat(100));
    expect(await cache.get(key(3))).toBe("c".repeat(100));
  });

  it("never stores a single entry larger than the cap", async () => {
    const cache = new IndexedDbIdlCache({ indexedDB: new IDBFactory(), maxBytes: 100 });
    await cache.set(key(1), "x".repeat(51));
    expect(await cache.get(key(1))).toBeUndefined();
  });

  it("behaves as an empty cache when IndexedDB is unavailable", async () => {
    const cache = new IndexedDbIdlCache({});
    const unavailable = (globalThis as { indexedDB?: IDBFactory }).indexedDB === undefined;
    expect(unavailable).toBe(true);
    await expect(cache.set(key(1), "{}")).resolves.toBeUndefined();
    await expect(cache.get(key(1))).resolves.toBeUndefined();
  });
});
