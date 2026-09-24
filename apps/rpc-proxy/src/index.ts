import { readBody } from "./body.js";
import { corsHeaders, parseAllowedOrigins, preflightHeaders } from "./cors.js";
import { checkPayload, MAX_BODY_BYTES, RPC_ERROR, type RpcId } from "./policy.js";
import { bindingLimiter, type Limiter, MemoryLimiter } from "./ratelimit.js";

/**
 * The Vigil RPC proxy: forwards allowlisted, read-only JSON-RPC calls from the Vigil web app to
 * one mainnet RPC endpoint whose URL (and API key) stays a Worker secret.
 *
 * It never logs: no `console` call exists in this Worker (a test checks), and no request body,
 * IP address or upstream URL is written anywhere. Only the client IP is used, as the rate-limit
 * key, and nothing is forwarded upstream but the checked JSON-RPC calls.
 */
export interface ProxyEnv {
  /** Secret: the upstream mainnet RPC URL, API key included. Never returned or logged. */
  readonly UPSTREAM_RPC_URL?: string;
  /** Comma-separated exact origins of the web app. */
  readonly ALLOWED_ORIGINS?: string;
  /** Cloudflare's rate limiting binding; absent → the best-effort in-memory limit. */
  readonly RATE_LIMITER?: RateLimit;
}

export const RATE_LIMIT_MESSAGE = "Rate limit reached. Set your own RPC in settings.";
/** Seconds a rate-limited client is told to wait (the binding's window is 60 s). */
const RETRY_AFTER_SECONDS = "60";
const UPSTREAM_TIMEOUT_MS = 20_000;

/** One per isolate: the fallback's counts live as long as the isolate does. */
const fallbackLimiter = new MemoryLimiter();

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<ProxyEnv>;

export async function handleRequest(request: Request, env: ProxyEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return health(request, env);
  }
  if (url.pathname !== "/") {
    return rpcError(404, RPC_ERROR.invalidRequest, "Not found", null);
  }

  const origin = request.headers.get("Origin");
  const allowedOrigin =
    origin !== null && parseAllowedOrigins(env.ALLOWED_ORIGINS).has(origin) ? origin : undefined;

  if (request.method === "OPTIONS") {
    return allowedOrigin === undefined
      ? new Response(null, { status: 403 })
      : new Response(null, { headers: preflightHeaders(allowedOrigin), status: 204 });
  }
  const cors = allowedOrigin === undefined ? {} : corsHeaders(allowedOrigin);
  if (request.method !== "POST") {
    return rpcError(405, RPC_ERROR.invalidRequest, "Only POST is accepted", null, {
      ...cors,
      Allow: "POST, OPTIONS",
    });
  }
  // Requests with no Origin (scripts, curl) are refused too. A non-browser client can forge the
  // header, so this only keeps casual use out; the rate limit is the real protection.
  if (allowedOrigin === undefined) {
    return rpcError(403, RPC_ERROR.originNotAllowed, "Origin not allowed", null);
  }

  if (!(await limiterFor(env).allow(clientKey(request)))) {
    return rpcError(429, RPC_ERROR.rateLimited, RATE_LIMIT_MESSAGE, null, {
      ...cors,
      "Retry-After": RETRY_AFTER_SECONDS,
    });
  }

  const upstream = upstreamUrl(env);
  if (upstream === undefined) {
    return rpcError(503, RPC_ERROR.notConfigured, "The proxy is not configured", null, cors);
  }
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return rpcError(
      415,
      RPC_ERROR.invalidRequest,
      "Content-Type must be application/json",
      null,
      cors,
    );
  }

  const body = await readBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too-large"
      ? rpcError(
          413,
          RPC_ERROR.invalidRequest,
          `Body larger than ${MAX_BODY_BYTES} bytes`,
          null,
          cors,
        )
      : rpcError(400, RPC_ERROR.parse, "Parse error", null, cors);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return rpcError(400, RPC_ERROR.parse, "Parse error", null, cors);
  }
  const checked = checkPayload(payload);
  if (!checked.ok) {
    const { status, code, message, id } = checked.refusal;
    return rpcError(status, code, message, id, cors);
  }

  // The checked calls, serialised again: exactly what was validated is what is sent (a duplicate
  // key, say, cannot mean one thing here and another upstream).
  const forwarded = JSON.stringify(checked.batch ? checked.calls : checked.calls[0]);
  const replyId = checked.batch ? null : (checked.calls[0]?.id ?? null);
  let response: Response;
  try {
    response = await fetch(upstream, {
      body: forwarded,
      headers: { "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return rpcError(
      502,
      RPC_ERROR.upstreamUnavailable,
      "The upstream RPC is unavailable",
      replyId,
      cors,
    );
  }
  if (response.status === 429) {
    await response.body?.cancel();
    return rpcError(429, RPC_ERROR.rateLimited, RATE_LIMIT_MESSAGE, replyId, {
      ...cors,
      "Retry-After": RETRY_AFTER_SECONDS,
    });
  }
  if (response.status !== 200) {
    // Never pass an upstream error page through: it could name the endpoint or its key.
    await response.body?.cancel();
    return rpcError(
      502,
      RPC_ERROR.upstreamUnavailable,
      "The upstream RPC is unavailable",
      replyId,
      cors,
    );
  }
  return new Response(response.body, {
    headers: { ...jsonHeaders(), ...cors },
    status: 200,
  });
}

function health(request: Request, env: ProxyEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { headers: { Allow: "GET, HEAD" }, status: 405 });
  }
  const configured =
    upstreamUrl(env) !== undefined && parseAllowedOrigins(env.ALLOWED_ORIGINS).size > 0;
  return new Response(
    request.method === "HEAD"
      ? null
      : JSON.stringify({ status: configured ? "ok" : "not-configured" }),
    { headers: jsonHeaders(), status: configured ? 200 : 503 },
  );
}

function limiterFor(env: ProxyEnv): Limiter {
  return env.RATE_LIMITER === undefined
    ? fallbackLimiter
    : bindingLimiter(env.RATE_LIMITER, fallbackLimiter);
}

/** The client IP as Cloudflare reports it; used as the rate-limit key only, never stored. */
function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/** The upstream URL if it is a usable `https:` URL. */
function upstreamUrl(env: ProxyEnv): string | undefined {
  const raw = env.UPSTREAM_RPC_URL;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  try {
    return new URL(raw).protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function jsonHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  };
}

function rpcError(
  status: number,
  code: number,
  message: string,
  id: RpcId | null,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message }, id, jsonrpc: "2.0" }), {
    headers: { ...jsonHeaders(), ...headers },
    status,
  });
}
