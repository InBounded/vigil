import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { withRetry } from "./retry.js";

function httpError(statusCode: number, headers: HeadersInit = {}): SolanaError {
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(headers),
    message: "boom",
    statusCode,
  });
}

describe("withRetry", () => {
  it("returns the result on the first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on a 429 and eventually succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce("ok");
    await expect(withRetry(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on a 503 and eventually succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce("ok");
    await expect(withRetry(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a 400 — rethrows immediately", async () => {
    const error = httpError(400);
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-HTTP error, e.g. a well-formed JSON-RPC error response", async () => {
    const error = new Error("some other failure");
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const error = httpError(500);
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withRetry(fn, { baseDelayMs: 1, maxAttempts: 3 })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("honors a Retry-After header instead of its own backoff", async () => {
    const start = Date.now();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429, { "retry-after": "0" }))
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { baseDelayMs: 10_000 });
    // With a huge baseDelayMs but Retry-After: 0, this must resolve almost immediately.
    expect(Date.now() - start).toBeLessThan(500);
  });
});
