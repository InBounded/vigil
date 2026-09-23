/**
 * The only HTTP the engine does besides the RPC: the program-verification API. Everything goes
 * through an injected `HttpClient`, so tests are offline and deterministic, and so the one real
 * implementation below can refuse any host that is not allowlisted (`AGENTS.md`: zero telemetry,
 * no network requests beyond the RPC and the program-verification API).
 */

/** Hosts the engine may contact over HTTP. `http.test.ts` checks nothing else calls `fetch`. */
export const ALLOWED_HTTP_HOSTS: readonly string[] = ["verify.osec.io"];

export interface HttpResponse {
  readonly status: number;
  /** The response body as UTF-8 text, at most `maxBytes` long. */
  readonly text: string;
}

export interface HttpGetOptions {
  readonly timeoutMs: number;
  /** Bodies longer than this are refused (`HttpError` code `TOO_LARGE`). */
  readonly maxBytes: number;
}

export interface HttpClient {
  get(url: string, options: HttpGetOptions): Promise<HttpResponse>;
}

export type HttpErrorCode = "HOST_NOT_ALLOWED" | "TIMEOUT" | "NETWORK" | "TOO_LARGE";

export class HttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.code = code;
  }
}

type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

/**
 * `HttpClient` over `fetch` (browser and Node ≥ 18). GET only, HTTPS only, allowlisted hosts only,
 * no cookies or credentials, no referrer, no redirects (a redirect could point anywhere).
 */
export class FetchHttpClient implements HttpClient {
  readonly #fetch: FetchFunction;
  readonly #allowedHosts: ReadonlySet<string>;

  constructor(
    fetchFunction: FetchFunction = (input, init) => globalThis.fetch(input, init),
    allowedHosts: readonly string[] = ALLOWED_HTTP_HOSTS,
  ) {
    this.#fetch = fetchFunction;
    this.#allowedHosts = new Set(allowedHosts);
  }

  async get(url: string, options: HttpGetOptions): Promise<HttpResponse> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !this.#allowedHosts.has(parsed.hostname) || parsed.port) {
      throw new HttpError(
        "HOST_NOT_ALLOWED",
        `refusing to contact ${parsed.protocol}//${parsed.host}`,
      );
    }
    const signal = AbortSignal.timeout(options.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(parsed.href, {
        credentials: "omit",
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch (error) {
      throw signal.aborted
        ? new HttpError(
            "TIMEOUT",
            `no answer from ${parsed.hostname} within ${options.timeoutMs} ms`,
          )
        : new HttpError("NETWORK", `could not reach ${parsed.hostname}: ${describe(error)}`);
    }
    try {
      return { status: response.status, text: await readLimited(response, options.maxBytes) };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw signal.aborted
        ? new HttpError(
            "TIMEOUT",
            `no complete answer from ${parsed.hostname} within ${options.timeoutMs} ms`,
          )
        : new HttpError(
            "NETWORK",
            `could not read the answer from ${parsed.hostname}: ${describe(error)}`,
          );
    }
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError("TOO_LARGE", `answer larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
