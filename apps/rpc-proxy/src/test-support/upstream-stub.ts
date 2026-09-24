/**
 * Stand-in for the upstream RPC in tests: Miniflare sends every outbound request of the Worker
 * here (`outboundService`), in Node. It only echoes what it received; the proxy is transport, so
 * what matters is exactly what reaches the upstream and what comes back.
 *
 * Special `id`s make it misbehave: `upstream-500` / `upstream-429` answer with that status and a
 * body naming the secret URL (which must never reach the client), `upstream-redirect` redirects,
 * `upstream-throw` fails like a network error.
 */
export const STUB_UPSTREAM_URL = "https://upstream.invalid/v2/rpc?api-key=TEST-SECRET-KEY";

export async function upstreamStub(request: Request): Promise<Response> {
  if (request.url !== STUB_UPSTREAM_URL) {
    return new Response(`unexpected upstream ${request.url}`, { status: 418 });
  }
  const text = await request.text();
  const payload: unknown = JSON.parse(text);
  const calls = (Array.isArray(payload) ? payload : [payload]) as Array<Record<string, unknown>>;
  const ids = calls.map((call) => call.id);
  if (ids.includes("upstream-500")) {
    return new Response(`Internal error at ${STUB_UPSTREAM_URL}`, { status: 500 });
  }
  if (ids.includes("upstream-429")) {
    return new Response(`Too many requests for ${STUB_UPSTREAM_URL}`, { status: 429 });
  }
  if (ids.includes("upstream-redirect")) {
    return new Response(null, { headers: { Location: STUB_UPSTREAM_URL }, status: 302 });
  }
  if (ids.includes("upstream-throw")) {
    throw new Error(`connect ECONNREFUSED ${STUB_UPSTREAM_URL}`);
  }
  const headers = [...request.headers.keys()].sort();
  const answers = calls.map((call) => ({
    id: call.id,
    jsonrpc: "2.0",
    result: { headers, method: call.method, params: call.params ?? null, raw: text },
  }));
  return Response.json(Array.isArray(payload) ? answers : answers[0]);
}
