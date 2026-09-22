import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
}

/**
 * Retries `fn` only on HTTP 429 and 5xx responses from the RPC transport (identified via
 * `@solana/kit`'s `SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR`), with exponential backoff and
 * jitter, honoring a `Retry-After` header when the server sends one. Any other error — including
 * a well-formed JSON-RPC error response — is rethrown immediately without retrying.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryAfterMs = getRetryableDelayMs(error);
      if (retryAfterMs === null || attempt === maxAttempts) {
        throw error;
      }
      await sleep(retryAfterMs ?? backoffWithJitter(attempt, baseDelayMs));
    }
  }
  // Unreachable: the loop above always either returns or throws.
  throw new Error("withRetry: exhausted attempts without returning or throwing");
}

/**
 * @returns `null` if `error` is not a retryable HTTP error; otherwise the number of milliseconds
 * to wait as instructed by a `Retry-After` header, or `undefined` if none was sent (caller should
 * fall back to its own backoff).
 */
function getRetryableDelayMs(error: unknown): number | null | undefined {
  if (!isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    return null;
  }
  const { statusCode, headers } = error.context;
  if (statusCode !== 429 && statusCode < 500) {
    return null;
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) {
    return undefined;
  }
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function backoffWithJitter(attempt: number, baseDelayMs: number): number {
  const exp = baseDelayMs * 2 ** (attempt - 1);
  return exp / 2 + Math.random() * (exp / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
