import { exports } from "cloudflare:workers";
import { ALLOWED_RPC_METHODS } from "@vigil-sol/core/rpc-allowlist";
import { describe, expect, it } from "vitest";
import { handleRequest, type ProxyEnv, RATE_LIMIT_MESSAGE } from "./index.js";
import { MAX_BATCH_CALLS, MAX_BODY_BYTES, RPC_ERROR } from "./policy.js";
import { FALLBACK_LIMIT } from "./ratelimit.js";
import { STUB_UPSTREAM_URL } from "./test-support/upstream-stub.js";

const ORIGIN = "https://vigil.example";
const SECRET_PARTS = ["TEST-SECRET-KEY", "upstream.invalid", "/v2/rpc"];

let ipCounter = 0;
/** A fresh client IP per call site, so rate-limit counts never leak between tests. */
function freshIp(): string {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 250)}.${ipCounter % 250}.1`;
}

interface PostOptions {
  readonly origin?: string | null;
  readonly ip?: string;
  readonly contentType?: string | null;
  readonly headers?: Record<string, string>;
}

function post(body: string | ReadableStream<Uint8Array>, options: PostOptions = {}): Request {
  const headers: Record<string, string> = { ...options.headers };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) {
    headers.Origin = origin;
  }
  const contentType =
    options.contentType === undefined ? "application/json; charset=utf-8" : options.contentType;
  if (contentType !== null) {
    headers["Content-Type"] = contentType;
  }
  headers["CF-Connecting-IP"] = options.ip ?? freshIp();
  return new Request("https://proxy.test/", { body, headers, method: "POST" });
}

function rpc(method: string, params?: unknown[], id: string | number = "1"): string {
  return JSON.stringify(
    params === undefined ? { id, jsonrpc: "2.0", method } : { id, jsonrpc: "2.0", method, params },
  );
}

async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

interface RpcErrorBody {
  jsonrpc: string;
  id: string | number | null;
  error: { code: number; message: string };
}

interface EchoResult {
  headers: string[];
  method: string;
  params: unknown[] | null;
  raw: string;
}

async function errorOf(response: Response): Promise<RpcErrorBody> {
  return (await response.json()) as RpcErrorBody;
}

async function echoOf(response: Response): Promise<EchoResult> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: EchoResult }).result;
}

/** Real parameters, as `KitRpcClient` sends them. */
const VALID_PARAMS: Record<(typeof ALLOWED_RPC_METHODS)[number], unknown[] | undefined> = {
  getAccountInfo: [
    "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
    { commitment: "confirmed", encoding: "base64" },
  ],
  getGenesisHash: undefined,
  getMultipleAccounts: [
    ["11111111111111111111111111111111", "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"],
    { commitment: "confirmed", encoding: "base64" },
  ],
  getSignaturesForAddress: ["11111111111111111111111111111111", { limit: 100 }],
  getSlot: [{ commitment: "confirmed" }],
  getTransaction: [
    "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
    { encoding: "base64", maxSupportedTransactionVersion: 0 },
  ],
  simulateTransaction: [
    "AQAAAA==",
    { encoding: "base64", replaceRecentBlockhash: true, sigVerify: false },
  ],
};

describe("GET /health", () => {
  it("answers ok when configured, without calling upstream", async () => {
    const response = await send(new Request("https://proxy.test/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("says not-configured (503) without an upstream or without origins, naming neither", async () => {
    for (const env of [
      { ALLOWED_ORIGINS: ORIGIN },
      { ALLOWED_ORIGINS: ORIGIN, UPSTREAM_RPC_URL: "http://plain-http.example/" },
      { UPSTREAM_RPC_URL: STUB_UPSTREAM_URL },
      { ALLOWED_ORIGINS: "not an origin", UPSTREAM_RPC_URL: STUB_UPSTREAM_URL },
    ] satisfies ProxyEnv[]) {
      const response = await handleRequest(new Request("https://proxy.test/health"), env);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"status":"not-configured"}');
    }
  });

  it("accepts HEAD and refuses other methods", async () => {
    const head = await send(new Request("https://proxy.test/health", { method: "HEAD" }));
    expect(head.status).toBe(200);
    const postHealth = await send(new Request("https://proxy.test/health", { method: "POST" }));
    expect(postHealth.status).toBe(405);
    expect(postHealth.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("HTTP method and path", () => {
  it("refuses GET on the RPC path with 405 and a JSON-RPC error", async () => {
    const response = await send(
      new Request("https://proxy.test/", { headers: { Origin: ORIGIN }, method: "GET" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
    expect((await errorOf(response)).error.code).toBe(RPC_ERROR.invalidRequest);
  });

  it("answers 404 on any other path", async () => {
    const response = await send(
      new Request("https://proxy.test/v1/rpc", { body: rpc("getSlot"), method: "POST" }),
    );
    expect(response.status).toBe(404);
  });
});

describe("method allowlist (imported from core)", () => {
  it.each(ALLOWED_RPC_METHODS)("forwards %s with its real parameters", async (method) => {
    const params = VALID_PARAMS[method];
    const echo = await echoOf(await send(post(rpc(method, params))));
    expect(echo.method).toBe(method);
    expect(echo.params).toEqual(params ?? null);
  });

  it.each([
    "sendTransaction",
    "getProgramAccounts",
    "getBalance",
    "getLatestBlockhash",
    "getBlock",
    "getTokenLargestAccounts",
    "accountSubscribe",
    "GETSLOT",
    "getSlot ",
    "__proto__",
    "constructor",
    "",
  ])("refuses %j with HTTP 403 and a JSON-RPC error, without calling upstream", async (method) => {
    const response = await send(post(rpc(method, [], 7)));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      error: { code: RPC_ERROR.methodNotAllowed, message: "Method not allowed by this proxy" },
      id: 7,
      jsonrpc: "2.0",
    });
  });
});

describe("parameter policy", () => {
  it.each([
    ["no config", ["AQAAAA=="]],
    ["sigVerify missing", ["AQAAAA==", { encoding: "base64" }]],
    ["sigVerify true", ["AQAAAA==", { encoding: "base64", sigVerify: true }]],
    ["sigVerify 'false' (string)", ["AQAAAA==", { encoding: "base64", sigVerify: "false" }]],
    ["sigVerify 0", ["AQAAAA==", { encoding: "base64", sigVerify: 0 }]],
    ["config not an object", ["AQAAAA==", "base64"]],
  ])("refuses simulateTransaction with %s (403)", async (_label, params) => {
    const response = await send(post(rpc("simulateTransaction", params)));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toEqual({
      code: RPC_ERROR.paramsNotAllowed,
      message: "simulateTransaction is only allowed with sigVerify: false",
    });
  });

  it("refuses simulateTransaction with no params at all", async () => {
    const response = await send(post(rpc("simulateTransaction")));
    expect(response.status).toBe(403);
  });

  it.each([
    ["no config (RPC default 1,000)", ["11111111111111111111111111111111"]],
    ["no limit", ["11111111111111111111111111111111", { before: "x" }]],
    ["limit 101", ["11111111111111111111111111111111", { limit: 101 }]],
    ["limit 1000", ["11111111111111111111111111111111", { limit: 1000 }]],
    ["limit 0", ["11111111111111111111111111111111", { limit: 0 }]],
    ["limit -1", ["11111111111111111111111111111111", { limit: -1 }]],
    ["limit 1.5", ["11111111111111111111111111111111", { limit: 1.5 }]],
    ['limit "50" (string)', ["11111111111111111111111111111111", { limit: "50" }]],
  ])("refuses getSignaturesForAddress with %s (403)", async (_label, params) => {
    const response = await send(post(rpc("getSignaturesForAddress", params)));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toEqual({
      code: RPC_ERROR.paramsNotAllowed,
      message: "getSignaturesForAddress needs a limit between 1 and 100",
    });
  });

  it("accepts getSignaturesForAddress with limit 1 and 100", async () => {
    for (const limit of [1, 100]) {
      const echo = await echoOf(
        await send(
          post(rpc("getSignaturesForAddress", ["11111111111111111111111111111111", { limit }])),
        ),
      );
      expect(echo.params).toEqual(["11111111111111111111111111111111", { limit }]);
    }
  });
});

describe("JSON-RPC shape", () => {
  it.each([
    ["not JSON", "{", 400, RPC_ERROR.parse],
    ["a number", "42", 400, RPC_ERROR.invalidRequest],
    ["null", "null", 400, RPC_ERROR.invalidRequest],
    ["jsonrpc 1.0", '{"jsonrpc":"1.0","id":1,"method":"getSlot"}', 400, RPC_ERROR.invalidRequest],
    ["no jsonrpc", '{"id":1,"method":"getSlot"}', 400, RPC_ERROR.invalidRequest],
    ["no id (notification)", '{"jsonrpc":"2.0","method":"getSlot"}', 400, RPC_ERROR.invalidRequest],
    ["object id", '{"jsonrpc":"2.0","id":{},"method":"getSlot"}', 400, RPC_ERROR.invalidRequest],
    [
      "fractional id",
      '{"jsonrpc":"2.0","id":1.5,"method":"getSlot"}',
      400,
      RPC_ERROR.invalidRequest,
    ],
    [
      "method not a string",
      '{"jsonrpc":"2.0","id":1,"method":["getSlot"]}',
      400,
      RPC_ERROR.invalidRequest,
    ],
    [
      "params as an object",
      '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":{}}',
      400,
      RPC_ERROR.invalidRequest,
    ],
    [
      "an extra field",
      '{"jsonrpc":"2.0","id":1,"method":"getSlot","extra":true}',
      400,
      RPC_ERROR.invalidRequest,
    ],
  ])("refuses %s", async (_label, body, status, code) => {
    const response = await send(post(body));
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error.code).toBe(code);
  });

  it("refuses an id longer than 64 characters", async () => {
    const response = await send(post(rpc("getSlot", undefined, "x".repeat(65))));
    expect(response.status).toBe(400);
  });

  it("forwards the checked call re-serialised: with duplicate keys, the value checked is the value sent", async () => {
    // JSON.parse keeps the last duplicate; the upstream must see that same single value.
    const body =
      '{"jsonrpc":"2.0","id":"d","method":"sendTransaction","method":"getSlot","params":[]}';
    const echo = await echoOf(await send(post(body)));
    expect(echo.raw).toBe('{"id":"d","jsonrpc":"2.0","method":"getSlot","params":[]}');

    const sim =
      '{"jsonrpc":"2.0","id":"s","method":"simulateTransaction","params":["AQAAAA==",{"sigVerify":true,"sigVerify":false}]}';
    const simEcho = await echoOf(await send(post(sim)));
    expect(JSON.parse(simEcho.raw)).toEqual({
      id: "s",
      jsonrpc: "2.0",
      method: "simulateTransaction",
      params: ["AQAAAA==", { sigVerify: false }],
    });
    expect(simEcho.raw).not.toContain("true");
  });

  it("keeps the caller's id in errors about one call", async () => {
    const response = await send(post(rpc("sendTransaction", [], "abc")));
    expect((await errorOf(response)).id).toBe("abc");
  });
});

describe("batches", () => {
  it(`forwards a batch of ${MAX_BATCH_CALLS} allowed calls`, async () => {
    const calls = Array.from({ length: MAX_BATCH_CALLS }, (_, i) => ({
      id: i,
      jsonrpc: "2.0",
      method: "getSlot",
    }));
    const response = await send(post(JSON.stringify(calls)));
    expect(response.status).toBe(200);
    const answers = (await response.json()) as Array<{ id: number; result: EchoResult }>;
    expect(answers.map((answer) => answer.id)).toEqual(calls.map((call) => call.id));
    expect(JSON.parse(answers[0]?.result.raw ?? "")).toEqual(calls);
  });

  it(`refuses a batch of ${MAX_BATCH_CALLS + 1} calls and an empty batch`, async () => {
    for (const length of [MAX_BATCH_CALLS + 1, 0]) {
      const calls = Array.from({ length }, (_, i) => ({
        id: i,
        jsonrpc: "2.0",
        method: "getSlot",
      }));
      const response = await send(post(JSON.stringify(calls)));
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toEqual({
        error: {
          code: RPC_ERROR.invalidRequest,
          message: `A batch must hold between 1 and ${MAX_BATCH_CALLS} calls`,
        },
        id: null,
        jsonrpc: "2.0",
      });
    }
  });

  it("refuses the whole batch when one call is not allowed (403, id null)", async () => {
    const calls = [
      { id: 1, jsonrpc: "2.0", method: "getSlot" },
      { id: 2, jsonrpc: "2.0", method: "sendTransaction", params: ["AQAAAA=="] },
    ];
    const response = await send(post(JSON.stringify(calls)));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      error: { code: RPC_ERROR.methodNotAllowed },
      id: null,
    });
  });

  it("refuses a nested batch", async () => {
    const response = await send(
      post(JSON.stringify([[{ id: 1, jsonrpc: "2.0", method: "getSlot" }]])),
    );
    expect(response.status).toBe(400);
  });
});

describe("body limits", () => {
  /** A valid getSlot call padded with JSON whitespace to exactly `size` bytes. */
  function paddedCall(size: number): string {
    const call = rpc("getSlot", [{ commitment: "confirmed" }]);
    return `${call}${" ".repeat(size - call.length)}`;
  }

  it(`accepts a body of exactly ${MAX_BODY_BYTES} bytes`, async () => {
    const body = paddedCall(MAX_BODY_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_BODY_BYTES);
    await echoOf(await send(post(body)));
  });

  it(`refuses ${MAX_BODY_BYTES + 1} bytes with 413`, async () => {
    const response = await send(post(paddedCall(MAX_BODY_BYTES + 1)));
    expect(response.status).toBe(413);
    expect((await errorOf(response)).error.message).toBe(
      `Body larger than ${MAX_BODY_BYTES} bytes`,
    );
  });

  it("refuses an oversized streamed body with no Content-Length", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(4096));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const request = post(stream);
    expect(request.headers.get("Content-Length")).toBeNull();
    const response = await send(request);
    expect(response.status).toBe(413);
  });

  it("refuses a Content-Length above the limit before reading", async () => {
    const response = await handleRequest(
      post(rpc("getSlot"), { headers: { "Content-Length": String(MAX_BODY_BYTES + 1) } }),
      { ALLOWED_ORIGINS: ORIGIN, UPSTREAM_RPC_URL: STUB_UPSTREAM_URL },
    );
    expect(response.status).toBe(413);
  });

  it("refuses a body that is not UTF-8", async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const response = await send(post(stream));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error.code).toBe(RPC_ERROR.parse);
  });

  it.each([
    ["text/plain", "text/plain"],
    ["form", "application/x-www-form-urlencoded"],
    ["none", null],
  ])("refuses Content-Type %s with 415", async (_label, contentType) => {
    const response = await send(post(rpc("getSlot"), { contentType }));
    expect(response.status).toBe(415);
  });
});

describe("CORS", () => {
  it("answers an allowed origin's preflight with exactly that origin", async () => {
    const response = await send(
      new Request("https://proxy.test/", {
        headers: {
          "Access-Control-Request-Headers": "content-type",
          "Access-Control-Request-Method": "POST",
          Origin: ORIGIN,
        },
        method: "OPTIONS",
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "content-type, solana-client",
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("allows every configured origin, including a loopback development origin", async () => {
    const response = await send(post(rpc("getSlot"), { origin: "http://localhost:5173" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it.each([
    ["another site", "https://evil.example"],
    ["a subdomain", "https://sub.vigil.example"],
    ["http instead of https", "http://vigil.example"],
    ["another port", "https://vigil.example:8443"],
    ["a trailing slash", "https://vigil.example/"],
    ["null (file:// page)", "null"],
    ["a suffix trick", "https://vigil.example.evil.example"],
  ])("refuses %s: 403, no CORS header, nothing forwarded", async (_label, origin) => {
    const preflight = await send(
      new Request("https://proxy.test/", { headers: { Origin: origin }, method: "OPTIONS" }),
    );
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const response = await send(post(rpc("getSlot"), { origin }));
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await errorOf(response)).error).toEqual({
      code: RPC_ERROR.originNotAllowed,
      message: "Origin not allowed",
    });
  });

  it("refuses a request with no Origin header (curl, scripts) with 403", async () => {
    const response = await send(post(rpc("getSlot"), { origin: null }));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error.code).toBe(RPC_ERROR.originNotAllowed);
    const preflight = await send(new Request("https://proxy.test/", { method: "OPTIONS" }));
    expect(preflight.status).toBe(403);
  });

  it("puts the CORS header on errors to an allowed origin, so the web app can read them", async () => {
    const response = await send(post(rpc("sendTransaction", [])));
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("allows nothing when ALLOWED_ORIGINS is empty or malformed", async () => {
    for (const ALLOWED_ORIGINS of ["", " , ", "vigil.example", "https://vigil.example/path", "*"]) {
      const response = await handleRequest(post(rpc("getSlot")), {
        ALLOWED_ORIGINS,
        UPSTREAM_RPC_URL: STUB_UPSTREAM_URL,
      });
      expect(response.status).toBe(403);
    }
  });
});

describe("upstream", () => {
  it("sends only the checked body and Content-Type upstream: no Origin, IP or client header", async () => {
    const echo = await echoOf(
      await send(
        post(rpc("getSlot"), {
          headers: { Authorization: "Bearer client", Cookie: "a=b", "X-Forwarded-For": "10.0.0.1" },
          ip: "192.0.2.77",
        }),
      ),
    );
    // `cf-worker` and `host` are added by the Workers runtime to every subrequest.
    expect(echo.headers).toEqual(["cf-worker", "content-length", "content-type", "host"]);
  });

  it("answers JSON, not cacheable, with the CORS header", async () => {
    const response = await send(post(rpc("getSlot")));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it.each([
    ["an upstream 500", "upstream-500", 502, RPC_ERROR.upstreamUnavailable],
    ["an upstream redirect", "upstream-redirect", 502, RPC_ERROR.upstreamUnavailable],
    ["a network failure", "upstream-throw", 502, RPC_ERROR.upstreamUnavailable],
    ["an upstream 429", "upstream-429", 429, RPC_ERROR.rateLimited],
  ])(
    "turns %s into a generic error that never names the upstream",
    async (_label, id, status, code) => {
      const response = await send(post(rpc("getSlot", undefined, id)));
      expect(response.status).toBe(status);
      const text = await response.text();
      for (const part of SECRET_PARTS) {
        expect(text).not.toContain(part);
      }
      expect((JSON.parse(text) as RpcErrorBody).error.code).toBe(code);
      expect((JSON.parse(text) as RpcErrorBody).id).toBe(id);
    },
  );

  it("answers 503 when the upstream secret is missing or not https, without naming it", async () => {
    for (const UPSTREAM_RPC_URL of [undefined, "", "http://plain.example/rpc?key=K", "not a url"]) {
      const env: ProxyEnv =
        UPSTREAM_RPC_URL === undefined
          ? { ALLOWED_ORIGINS: ORIGIN }
          : { ALLOWED_ORIGINS: ORIGIN, UPSTREAM_RPC_URL };
      const response = await handleRequest(post(rpc("getSlot")), env);
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain("plain.example");
      expect(text).not.toContain("key=K");
      expect((JSON.parse(text) as RpcErrorBody).error.code).toBe(RPC_ERROR.notConfigured);
    }
  });

  it("never returns the upstream URL in any answer of this suite's error paths", async () => {
    const requests = [
      post("{"),
      post(rpc("sendTransaction", [])),
      post(rpc("simulateTransaction", ["AQAAAA==", { sigVerify: true }])),
      post(rpc("getSlot"), { origin: "https://evil.example" }),
      post(rpc("getSlot"), { contentType: "text/plain" }),
      new Request("https://proxy.test/nope"),
      new Request("https://proxy.test/health"),
    ];
    for (const request of requests) {
      const text = await (await send(request)).text();
      for (const part of SECRET_PARTS) {
        expect(text).not.toContain(part);
      }
    }
  });
});

describe("rate limiting", () => {
  it("with the binding (limit 5 in tests): the 6th request from one IP gets 429 and the message", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 5; i += 1) {
      expect((await send(post(rpc("getSlot"), { ip }))).status).toBe(200);
    }
    const limited = await send(post(rpc("getSlot"), { ip }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(limited.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(await errorOf(limited)).toEqual({
      error: {
        code: RPC_ERROR.rateLimited,
        message: "Rate limit reached. Set your own RPC in settings.",
      },
      id: null,
      jsonrpc: "2.0",
    });
    expect(RATE_LIMIT_MESSAGE).toBe("Rate limit reached. Set your own RPC in settings.");

    // Another client is not affected.
    expect((await send(post(rpc("getSlot"), { ip: "203.0.113.11" }))).status).toBe(200);
  });

  it("counts refused requests too, so bad requests cannot be sent without limit", async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < 5; i += 1) {
      expect((await send(post(rpc("sendTransaction", []), { ip }))).status).toBe(403);
    }
    expect((await send(post(rpc("getSlot"), { ip }))).status).toBe(429);
  });

  it("without the binding, falls back to the in-memory limit of the isolate", async () => {
    const env: ProxyEnv = { ALLOWED_ORIGINS: ORIGIN, UPSTREAM_RPC_URL: STUB_UPSTREAM_URL };
    const ip = "203.0.113.30";
    for (let i = 0; i < FALLBACK_LIMIT; i += 1) {
      expect((await handleRequest(post(rpc("getSlot"), { ip }), env)).status).toBe(200);
    }
    const limited = await handleRequest(post(rpc("getSlot"), { ip }), env);
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).error.message).toBe(RATE_LIMIT_MESSAGE);
    expect((await handleRequest(post(rpc("getSlot"), { ip: "203.0.113.31" }), env)).status).toBe(
      200,
    );
  });

  it("falls back to the in-memory limit when the binding call fails", async () => {
    const env: ProxyEnv = {
      ALLOWED_ORIGINS: ORIGIN,
      RATE_LIMITER: {
        limit: () => Promise.reject(new Error("binding unavailable")),
      },
      UPSTREAM_RPC_URL: STUB_UPSTREAM_URL,
    };
    const ip = "203.0.113.40";
    for (let i = 0; i < FALLBACK_LIMIT; i += 1) {
      expect((await handleRequest(post(rpc("getSlot"), { ip }), env)).status).toBe(200);
    }
    expect((await handleRequest(post(rpc("getSlot"), { ip }), env)).status).toBe(429);
  });
});

describe("source hygiene", () => {
  const sources = import.meta.glob<string>(["./*.ts", "!./*.test.ts"], {
    eager: true,
    import: "default",
    query: "?raw",
  });

  it("has sources to check", () => {
    expect(Object.keys(sources).sort()).toEqual([
      "./body.ts",
      "./cors.ts",
      "./index.ts",
      "./policy.ts",
      "./ratelimit.ts",
    ]);
  });

  it("never logs: no console call in the Worker", () => {
    for (const [path, source] of Object.entries(sources)) {
      expect(source, path).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("keeps no copy of the method list: the allowlist comes from core", () => {
    for (const [path, source] of Object.entries(sources)) {
      expect(source, path).not.toMatch(/"getMultipleAccounts"|"simulateTransaction"\s*,/);
    }
    expect(sources["./policy.ts"]).toContain('from "@vigil-sol/core/rpc-allowlist"');
  });
});
