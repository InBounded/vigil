import { type AllowedRpcMethod, isAllowedRpcMethod } from "@vigil-sol/core/rpc-allowlist";

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 16 * 1024;
/** Most calls in one JSON-RPC batch. */
export const MAX_BATCH_CALLS = 10;
/** Largest `limit` accepted for `getSignaturesForAddress` (the RPC's own default is 1,000). */
export const MAX_SIGNATURES_LIMIT = 100;
/** Longest string `id` accepted. */
const MAX_ID_LENGTH = 64;

/** JSON-RPC error codes this proxy answers with (the -32000 range is server-defined). */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotAllowed: -32601,
  paramsNotAllowed: -32602,
  internal: -32603,
  originNotAllowed: -32001,
  notConfigured: -32002,
  upstreamUnavailable: -32003,
  rateLimited: -32005,
} as const;

export type RpcId = string | number;

/** One call, rebuilt from the checked fields only: this is what is sent upstream. */
export interface RpcCall {
  readonly jsonrpc: "2.0";
  readonly id: RpcId;
  readonly method: AllowedRpcMethod;
  readonly params?: readonly unknown[];
}

export interface Refusal {
  readonly status: 400 | 403;
  readonly code: number;
  readonly message: string;
  readonly id: RpcId | null;
}

export type Checked =
  | { readonly ok: true; readonly batch: boolean; readonly calls: readonly RpcCall[] }
  | { readonly ok: false; readonly refusal: Refusal };

const CALL_KEYS = new Set(["jsonrpc", "id", "method", "params"]);

/**
 * Checks a parsed request body against the proxy's policy: JSON-RPC 2.0, allowlisted methods
 * only, `simulateTransaction` with `sigVerify: false`, `getSignaturesForAddress` with an explicit
 * `limit` of at most {@link MAX_SIGNATURES_LIMIT}, batches of 1 to {@link MAX_BATCH_CALLS} calls.
 * One refused call refuses the whole request.
 */
export function checkPayload(payload: unknown): Checked {
  if (Array.isArray(payload)) {
    if (payload.length === 0 || payload.length > MAX_BATCH_CALLS) {
      return refuse(
        400,
        RPC_ERROR.invalidRequest,
        `A batch must hold between 1 and ${MAX_BATCH_CALLS} calls`,
        null,
      );
    }
    const calls: RpcCall[] = [];
    for (const item of payload) {
      const checked = checkCall(item);
      if (!checked.ok) {
        // In a batch the error answers the whole request, not one call.
        return { ok: false, refusal: { ...checked.refusal, id: null } };
      }
      calls.push(checked.call);
    }
    return { batch: true, calls, ok: true };
  }
  const checked = checkCall(payload);
  return checked.ok ? { batch: false, calls: [checked.call], ok: true } : checked;
}

type CallChecked =
  | { readonly ok: true; readonly call: RpcCall }
  | { readonly ok: false; readonly refusal: Refusal };

function checkCall(value: unknown): CallChecked {
  if (!isRecord(value)) {
    return refuse(400, RPC_ERROR.invalidRequest, "Invalid JSON-RPC request", null);
  }
  const id = validId(value.id);
  if (
    value.jsonrpc !== "2.0" ||
    id === undefined ||
    typeof value.method !== "string" ||
    Object.keys(value).some((key) => !CALL_KEYS.has(key))
  ) {
    return refuse(400, RPC_ERROR.invalidRequest, "Invalid JSON-RPC 2.0 request", id ?? null);
  }
  const params = value.params;
  if (params !== undefined && !Array.isArray(params)) {
    return refuse(400, RPC_ERROR.invalidRequest, "params must be an array", id);
  }
  const method = value.method;
  if (!isAllowedRpcMethod(method)) {
    return refuse(403, RPC_ERROR.methodNotAllowed, "Method not allowed by this proxy", id);
  }
  const config: unknown = params?.[1];
  if (method === "simulateTransaction") {
    if (!isRecord(config) || config.sigVerify !== false) {
      return refuse(
        403,
        RPC_ERROR.paramsNotAllowed,
        "simulateTransaction is only allowed with sigVerify: false",
        id,
      );
    }
  }
  if (method === "getSignaturesForAddress") {
    const limit = isRecord(config) ? config.limit : undefined;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_SIGNATURES_LIMIT
    ) {
      return refuse(
        403,
        RPC_ERROR.paramsNotAllowed,
        `getSignaturesForAddress needs a limit between 1 and ${MAX_SIGNATURES_LIMIT}`,
        id,
      );
    }
  }
  return {
    call:
      params === undefined
        ? { id, jsonrpc: "2.0", method }
        : { id, jsonrpc: "2.0", method, params },
    ok: true,
  };
}

function validId(value: unknown): RpcId | undefined {
  if (typeof value === "string" && value.length <= MAX_ID_LENGTH) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  return undefined;
}

function refuse(
  status: Refusal["status"],
  code: number,
  message: string,
  id: RpcId | null,
): { readonly ok: false; readonly refusal: Refusal } {
  return { ok: false, refusal: { code, id, message, status } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
