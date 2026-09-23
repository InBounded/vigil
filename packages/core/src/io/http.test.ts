import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED_HTTP_HOSTS, FetchHttpClient, HttpError } from "./http.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Call[] = [];
  const fetchFunction = (url: string, init: RequestInit) => {
    calls.push({ init, url });
    return respond(url, init);
  };
  return { calls, fetchFunction };
}

const OK = "https://verify.osec.io/status/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const options = { maxBytes: 1024, timeoutMs: 50 };

describe("FetchHttpClient", () => {
  it("allows only the verification API host", () => {
    expect(ALLOWED_HTTP_HOSTS).toEqual(["verify.osec.io"]);
  });

  it("refuses any other host, plain HTTP, or an explicit port, without calling fetch", async () => {
    const { calls, fetchFunction } = fakeFetch(() => Promise.resolve(new Response("{}")));
    const client = new FetchHttpClient(fetchFunction);
    for (const url of [
      "https://example.com/status/x",
      "http://verify.osec.io/status/x",
      "https://verify.osec.io:8443/status/x",
      "https://verify.osec.io.evil.example/status/x",
      "https://user:pass@example.com/",
    ]) {
      await expect(client.get(url, options), url).rejects.toMatchObject({
        code: "HOST_NOT_ALLOWED",
      });
    }
    expect(calls).toEqual([]);
  });

  it("sends a plain GET with no credentials, no referrer and no redirects", async () => {
    const { calls, fetchFunction } = fakeFetch(() =>
      Promise.resolve(new Response('{"is_verified":false}')),
    );
    const response = await new FetchHttpClient(fetchFunction).get(OK, options);
    expect(response).toEqual({ status: 200, text: '{"is_verified":false}' });
    expect(calls[0]?.url).toBe(OK);
    expect(calls[0]?.init).toMatchObject({
      credentials: "omit",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  });

  it("times out, refuses oversized answers and reports network errors, all as HttpError", async () => {
    const hanging = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(new FetchHttpClient(hanging.fetchFunction).get(OK, options)).rejects.toMatchObject(
      {
        code: "TIMEOUT",
      },
    );
    const huge = fakeFetch(() => Promise.resolve(new Response("x".repeat(2048))));
    await expect(new FetchHttpClient(huge.fetchFunction).get(OK, options)).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const error = await new FetchHttpClient(down.fetchFunction)
      .get(OK, options)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      code: "NETWORK",
      message: "could not reach verify.osec.io: fetch failed",
    });
    const empty = fakeFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    expect(await new FetchHttpClient(empty.fetchFunction).get(OK, options)).toEqual({
      status: 204,
      text: "",
    });
  });
});

describe("network access in the engine", () => {
  it("only io/http.ts calls fetch (zero telemetry, AGENTS.md)", async () => {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          const source = await readFile(full, "utf8");
          if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(source)) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    await walk(root);
    expect(offenders).toEqual([path.join("io", "http.ts")]);
  });
});
