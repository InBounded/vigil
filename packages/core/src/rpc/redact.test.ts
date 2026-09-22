import { describe, expect, it } from "vitest";
import { redactRpcUrl } from "./redact.js";

describe("redactRpcUrl", () => {
  it("strips an API key embedded in the path", () => {
    expect(redactRpcUrl("https://rpc.example.com/abc123secretkey")).toBe("https://rpc.example.com");
  });

  it("strips an API key embedded in the query string", () => {
    expect(redactRpcUrl("https://rpc.example.com/?api-key=abc123secretkey")).toBe(
      "https://rpc.example.com",
    );
  });

  it("strips both a path segment and a query string key together", () => {
    expect(redactRpcUrl("https://rpc.example.com/v2/abc123?api-key=def456")).toBe(
      "https://rpc.example.com",
    );
  });

  it("keeps a non-default port, since the host includes it", () => {
    expect(redactRpcUrl("http://localhost:8899/secret-path")).toBe("http://localhost:8899");
  });

  it("returns a fixed placeholder for an unparseable URL, never the raw input", () => {
    expect(redactRpcUrl("not a url")).toBe("invalid-url");
  });
});
