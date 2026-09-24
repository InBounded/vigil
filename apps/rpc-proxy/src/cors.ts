/** Hosts that may be allowed over plain `http:` (local development of the web app). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The web app origins allowed to call the proxy, from the comma-separated `ALLOWED_ORIGINS`
 * variable. Each entry must be an exact origin (`https://vigil.example`, no path or trailing
 * slash); `http:` only for loopback hosts. Anything else is ignored, so a mistake allows less,
 * never more.
 */
export function parseAllowedOrigins(raw: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const candidate = entry.trim();
    if (candidate !== "" && isExactOrigin(candidate)) {
      origins.add(candidate);
    }
  }
  return origins;
}

function isExactOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return secure && url.origin === value;
}

/** Headers of every answer to an allowed origin. */
export function corsHeaders(origin: string): Record<string, string> {
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

/**
 * Preflight answer headers. `solana-client` is the header `@solana/kit`'s Node transport adds;
 * the browser transport sends only `content-type` and `accept` (a CORS-safelisted header).
 */
export function preflightHeaders(origin: string): Record<string, string> {
  return {
    ...corsHeaders(origin),
    "Access-Control-Allow-Headers": "content-type, solana-client",
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Max-Age": "86400",
  };
}
