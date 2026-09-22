/**
 * Reduces an RPC URL to its host only. RPC URLs frequently carry API keys in the path or query
 * string (`https://rpc.example.com/abc123` or `?api-key=abc123`); per `AGENTS.md`, those must
 * never appear in code, logs, reports, or errors.
 */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid-url";
  }
}
