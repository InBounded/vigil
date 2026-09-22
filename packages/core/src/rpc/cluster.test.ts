import { describe, expect, it } from "vitest";
import { detectCluster } from "./cluster.js";

describe("detectCluster", () => {
  it("recognizes mainnet-beta's genesis hash", () => {
    expect(detectCluster("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")).toBe("mainnet");
  });

  it("recognizes devnet's genesis hash", () => {
    expect(detectCluster("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")).toBe("devnet");
  });

  it("recognizes testnet's genesis hash", () => {
    expect(detectCluster("4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY")).toBe("testnet");
  });

  it("returns 'unknown' for an unrecognized hash, never throws", () => {
    expect(detectCluster("not-a-real-genesis-hash")).toBe("unknown");
  });
});
