import { type Address, getAddressDecoder } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDecodeContext, decodeInstruction, PROGRAM_DECODERS } from "./decode.js";
import { DecodeError } from "./errors.js";
import { parseWireTransaction } from "./transaction.js";

const addressDecoder = getAddressDecoder();
const programIds = PROGRAM_DECODERS.flatMap((decoder) => decoder.programIds);

const accountArbitrary = fc.record({
  address: fc.uint8Array({ maxLength: 32, minLength: 32 }).map((b) => addressDecoder.decode(b)),
  isSigner: fc.boolean(),
  isWritable: fc.boolean(),
});

/**
 * Thousands of runs take ~2 s alone but can exceed Vitest's 5 s default under `pnpm check`
 * (coverage, parallel workers); a generous timeout keeps the run count on slow machines and CI.
 */
const FUZZ = { timeout: 60_000 };

describe("decoders on hostile input", () => {
  it("decodeInstruction never throws, whatever the data and accounts", FUZZ, () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Address>(...programIds),
        // Bias the first byte towards real tags so decoders get past identification.
        fc.tuple(fc.integer({ max: 50, min: 0 }), fc.uint8Array({ maxLength: 300 })),
        fc.array(accountArbitrary, { maxLength: 12 }),
        (programId, [tag, rest], accounts) => {
          const data = Uint8Array.from([tag, ...rest]);
          const context = createDecodeContext();
          const decoded = decodeInstruction({ accounts, data, programId }, 0, context, 0, 0);
          expect(["native", "squads", "none"]).toContain(decoded.decoder);
          if (decoded.decoder === "none") {
            expect(context.gaps.length).toBeGreaterThan(0);
          }
          expect(decoded.accounts).toHaveLength(accounts.length);
        },
      ),
      { numRuns: 5000 },
    );
  });

  it("parseWireTransaction only ever throws a DecodeError", FUZZ, () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 1232 }), (bytes) => {
        try {
          parseWireTransaction(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns: 3000 },
    );
  });
});
