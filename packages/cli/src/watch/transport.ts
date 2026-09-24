/** An HTTP answer, reduced to what the notifiers read. */
export interface NotifierResponse {
  readonly status: number;
  /** The `Retry-After` header in seconds, when present and numeric. */
  readonly retryAfterSeconds: number | null;
  /** The body, cut at 64 KiB. */
  readonly body: string;
}

/**
 * How notifiers reach Discord and Telegram: one JSON POST. Implementations never put the URL (it
 * holds the webhook token or the bot token) in an error message.
 */
export interface NotifierHttp {
  post(url: string, json: unknown): Promise<NotifierResponse>;
}

/** A failed request, with a message that holds no URL. */
export class NotifierTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifierTransportError";
  }
}

const TIMEOUT_MS = 15_000;
const MAX_BODY = 64 * 1024;

type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The real transport over `fetch`: POST, JSON, no redirects (a redirect could send the payload
 * anywhere), no referrer, 15 s timeout.
 *
 * Test-only: with `NODE_ENV=test` and `VIGIL_TEST_NOTIFY_ORIGIN=http://127.0.0.1:<port>`, requests
 * go to that local server instead (path and query kept), so the tests exercise this code against
 * a fake server. Any other origin is refused, so the switch can only point at this machine.
 */
export function fetchNotifierHttp(
  env: Readonly<Record<string, string | undefined>>,
  fetchFunction: FetchFunction = (input, init) => fetch(input, init),
): NotifierHttp {
  const override = testOrigin(env);
  return {
    async post(url, json) {
      const target = override === undefined ? url : redirectTo(url, override);
      let response: Response;
      try {
        response = await fetchFunction(target, {
          body: JSON.stringify(json),
          headers: { "content-type": "application/json" },
          method: "POST",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const timeout = error instanceof Error && error.name === "TimeoutError";
        throw new NotifierTransportError(timeout ? "the request timed out" : "network error");
      }
      const retryAfter = response.headers.get("retry-after");
      const seconds =
        retryAfter !== null && /^\d+(\.\d+)?$/.test(retryAfter.trim())
          ? Number(retryAfter.trim())
          : null;
      let body = "";
      try {
        body = (await response.text()).slice(0, MAX_BODY);
      } catch {
        body = "";
      }
      return { body, retryAfterSeconds: seconds, status: response.status };
    },
  };
}

function testOrigin(env: Readonly<Record<string, string | undefined>>): URL | undefined {
  const value = env.VIGIL_TEST_NOTIFY_ORIGIN;
  if (env.NODE_ENV !== "test" || value === undefined || value === "") {
    return undefined;
  }
  const url = new URL(value);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("VIGIL_TEST_NOTIFY_ORIGIN must be a local http:// origin");
  }
  return url;
}

function redirectTo(url: string, origin: URL): string {
  const parsed = new URL(url);
  return `${origin.origin}/${parsed.host}${parsed.pathname}${parsed.search}`;
}
