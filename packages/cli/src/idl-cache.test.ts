import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCacheDir, FileIdlCache } from "./idl-cache.js";

const KEY = `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD:${"ab".repeat(32)}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vigil-idl-cache-"));
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("defaultCacheDir", () => {
  it("honours an absolute XDG_CACHE_HOME", () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/var/cache/me" }, "/home/me")).toBe(
      "/var/cache/me/vigil",
    );
  });

  it("falls back to ~/.cache when XDG_CACHE_HOME is unset, empty or relative", () => {
    for (const env of [{}, { XDG_CACHE_HOME: "" }, { XDG_CACHE_HOME: "relative/dir" }]) {
      expect(defaultCacheDir(env, "/home/me")).toBe("/home/me/.cache/vigil");
    }
  });
});

describe("FileIdlCache", () => {
  it("stores and returns an entry, as a user-only file named after the key", async () => {
    const cache = new FileIdlCache(dir);
    expect(await cache.get(KEY)).toBeUndefined();
    await cache.set(KEY, '{"instructions":[]}');
    expect(await cache.get(KEY)).toBe('{"instructions":[]}');
    const files = await readdir(path.join(dir, "idl"));
    expect(files).toEqual([`${KEY.replace(":", "-")}.json`]);
    const mode = (await stat(path.join(dir, "idl", files[0] ?? ""))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses keys that are not <program>:<sha256>, so nothing can escape the cache directory", async () => {
    const cache = new FileIdlCache(dir);
    for (const key of ["../../etc/passwd", `x:${"ab".repeat(32)}`, `${KEY}/..`, ""]) {
      await expect(cache.set(key, "{}")).rejects.toThrow(TypeError);
      await expect(cache.get(key)).resolves.toBeUndefined();
    }
  });

  it("ignores entries above 5 MB instead of reading them", async () => {
    const cache = new FileIdlCache(dir);
    await cache.set(KEY, "x".repeat(5_000_001));
    expect(await cache.get(KEY)).toBeUndefined();
    await mkdir(path.join(dir, "idl"), { recursive: true });
    await writeFile(path.join(dir, "idl", `${KEY.replace(":", "-")}.json`), "y".repeat(5_000_001));
    expect(await cache.get(KEY)).toBeUndefined();
  });
});
