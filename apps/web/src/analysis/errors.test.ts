import { AnalysisError } from "@vigil-sol/core";
import { describe, expect, it } from "vitest";
import { describeError } from "./errors.js";

describe("describeError", () => {
  it("names each AnalysisError, keeping only the RPC failure's safe detail", () => {
    expect(describeError(new AnalysisError("NOT_A_MULTISIG", "x"))).toEqual({
      key: "error.NOT_A_MULTISIG",
      params: {},
    });
    expect(
      describeError(new AnalysisError("RPC_FAILED", "the endpoint answered HTTP 429")),
    ).toEqual({ key: "error.RPC_FAILED", params: { detail: "the endpoint answered HTTP 429" } });
  });

  it("never shows the text of any other error: it could hold the endpoint URL and its key", () => {
    const shown = describeError(
      new Error("fetch failed: https://rpc.example.test/?api-key=secret"),
    );
    expect(shown).toEqual({ key: "error.UNEXPECTED", params: {} });
    expect(describeError("string thrown")).toEqual({ key: "error.UNEXPECTED", params: {} });
  });
});
