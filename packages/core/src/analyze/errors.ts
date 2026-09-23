import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import { sanitizeOnchainString } from "../sanitize/sanitize.js";

export type AnalysisErrorCode =
  /** The address is not a Squads v4 multisig (or does not exist). */
  | "NOT_A_MULTISIG"
  /** No transaction exists at that index (never created, or its account was closed). */
  | "TRANSACTION_NOT_FOUND"
  /** The transaction account exists but cannot be read as a Squads transaction. */
  | "TRANSACTION_INVALID"
  /** The raw transaction input is not a valid base64 wire transaction. */
  | "INVALID_TRANSACTION"
  /** An RPC call the analysis cannot do without failed. */
  | "RPC_FAILED";

/**
 * Why an analysis could not produce a report at all. Anything the analysis can survive is an
 * `AnalysisGap` in the report instead. Messages never contain an RPC URL.
 */
export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;

  constructor(code: AnalysisErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnalysisError";
    this.code = code;
  }
}

/**
 * An RPC failure as an `AnalysisError`, keeping only what is safe to show: the HTTP status or the
 * JSON-RPC server message, never the transport's own message (it can contain the endpoint URL and
 * its API key). The original error is not attached as `cause` for the same reason.
 */
export function rpcFailure(what: string, error: unknown): AnalysisError {
  let detail = "the endpoint could not be reached or gave an invalid answer";
  if (isSolanaError(error)) {
    if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
      detail = `the endpoint answered HTTP ${error.context.statusCode}`;
    } else {
      const context = error.context as {
        readonly __code?: unknown;
        readonly __serverMessage?: unknown;
      };
      if (typeof context.__code === "number" && typeof context.__serverMessage === "string") {
        const message = sanitizeOnchainString(context.__serverMessage, "text").text;
        detail = `the endpoint answered error ${context.__code}: ${message}`;
      }
    }
  }
  return new AnalysisError("RPC_FAILED", `${what}: ${detail}`);
}
