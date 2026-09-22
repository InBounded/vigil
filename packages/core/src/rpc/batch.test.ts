import { describe, expect, it } from "vitest";
import { chunk, mapWithConcurrency } from "./batch.js";

describe("chunk", () => {
  it("splits evenly divisible input into equal chunks", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("puts the remainder in a final, shorter chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk([], 100)).toEqual([]);
  });

  it("returns a single chunk when size exceeds the input length", () => {
    expect(chunk([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
  });

  it("chunks 250 items into 100/100/50, matching getMultipleAccounts' real limit", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunk(items, 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves output order regardless of completion order", async () => {
    const delays = [30, 10, 20, 0, 15];
    const result = await mapWithConcurrency(delays, 3, async (delayMs, index) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it("never runs more than `concurrency` calls at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("handles an empty input without invoking fn", async () => {
    let calls = 0;
    const result = await mapWithConcurrency([], 4, async (item: number) => {
      calls++;
      return await Promise.resolve(item);
    });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });
});
