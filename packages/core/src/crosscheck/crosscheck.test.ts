/**
 * RPC cross-check (Phase 5.3) on real data: the live upgrade buffer 6W37H2Xf... captured twice, a
 * minute apart, while it was being written (`crosscheck-buffer-{earlier,later}.json.gz`). Serving
 * the earlier capture as the second RPC reproduces an endpoint that lags or lies, with real bytes.
 */
import { address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { renderFinding } from "../i18n/render.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import type { FixtureData } from "../rpc/index.js";
import { rpcDisagreement } from "../rules/catalog/critical.js";
import { computeVerdict, runRules } from "../rules/engine.js";
import { context, loadFixture } from "../test-support/rules.js";
import { accountContentHash, type CriticalAccount, crossCheckAccounts } from "./index.js";

const BUFFER = address("6W37H2XfGJmq3LXCjUt6Zzv5mpSDcLVeyCPsvjDaSfZX");
const MULTISIG = address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt");

let earlier: FixtureData;
let later: FixtureData;
let proposal: FixtureData;
beforeAll(async () => {
  earlier = await loadFixture("crosscheck-buffer-earlier.json.gz");
  later = await loadFixture("crosscheck-buffer-later.json.gz");
  proposal = await loadFixture("vault-transaction");
});

/** Counts `getMultipleAccounts` calls on a fixture client. */
function counted(data: FixtureData) {
  const rpc = new FixtureRpcClient(data);
  const calls: (bigint | undefined)[] = [];
  const read = rpc.getMultipleAccounts.bind(rpc);
  rpc.getMultipleAccounts = (addresses, options) => {
    calls.push(options?.minContextSlot);
    return read(addresses, options);
  };
  return { calls, rpc };
}

const accounts: CriticalAccount[] = [
  { address: BUFFER, kind: "buffer" },
  { address: MULTISIG, kind: "multisig" },
];

describe("crossCheckAccounts", () => {
  it("finds nothing when both RPCs return the same content", async () => {
    const result = await crossCheckAccounts(
      new FixtureRpcClient(later),
      new FixtureRpcClient(later),
      accounts,
    );
    expect(result).toEqual({ gaps: [], mismatches: [] });
  });

  it("reports a real disagreement after re-reading both at the later slot", async () => {
    const primary = counted({
      ...later,
      accounts: new Map([...later.accounts, ...proposal.accounts]),
    });
    const secondary = counted({
      ...earlier,
      accounts: new Map([...earlier.accounts, ...proposal.accounts]),
    });
    const result = await crossCheckAccounts(primary.rpc, secondary.rpc, accounts);
    expect(result.mismatches).toEqual([
      {
        address: BUFFER,
        kind: "buffer",
        primarySha256: await accountContentHash(later.accounts.get(BUFFER) ?? null),
        secondarySha256: await accountContentHash(earlier.accounts.get(BUFFER) ?? null),
      },
    ]);
    expect(result.mismatches[0]?.primarySha256).not.toBe(result.mismatches[0]?.secondarySha256);
    expect(result.gaps).toEqual([
      {
        address: BUFFER,
        code: "RPC_MISMATCH",
        message: "the two RPCs return different content for this buffer account",
      },
    ]);
    // The two captures are at different slots, so both RPCs were asked again at the later one.
    expect(later.contextSlot).toBeGreaterThan(earlier.contextSlot);
    expect(primary.calls).toEqual([undefined, later.contextSlot]);
    expect(secondary.calls).toEqual([undefined, later.contextSlot]);
  });

  it("treats an account missing on one RPC as a disagreement", async () => {
    const result = await crossCheckAccounts(
      new FixtureRpcClient(later),
      new FixtureRpcClient({ ...later, accounts: new Map() }),
      [{ address: BUFFER, kind: "buffer" }],
    );
    expect(result.mismatches).toEqual([
      expect.objectContaining({ address: BUFFER, secondarySha256: null }),
    ]);
  });

  it("ends with a gap, never an exception, when either RPC cannot be read", async () => {
    const down = new FixtureRpcClient(later);
    down.getMultipleAccounts = () => Promise.reject(new Error("unreachable"));
    for (const [primary, secondary, which] of [
      [down, new FixtureRpcClient(later), "primary"],
      [new FixtureRpcClient(later), down, "second"],
    ] as const) {
      const result = await crossCheckAccounts(primary, secondary, accounts);
      expect(result).toEqual({
        gaps: [
          {
            code: "RPC_CROSS_CHECK_FAILED",
            message: `the ${which} RPC could not be read, so the accounts were not compared between the two RPCs`,
          },
        ],
        mismatches: [],
      });
    }
    expect(await crossCheckAccounts(down, down, [])).toEqual({ gaps: [], mismatches: [] });
  });

  it("hashes what an account holds, not its lamports", async () => {
    const real = later.accounts.get(BUFFER) ?? null;
    if (real === null) {
      throw new Error("fixture incomplete");
    }
    expect(await accountContentHash({ ...real, lamports: real.lamports + 1n })).toBe(
      await accountContentHash(real),
    );
    expect(await accountContentHash({ ...real, owner: MULTISIG })).not.toBe(
      await accountContentHash(real),
    );
    expect(await accountContentHash(null)).toBeNull();
  });
});

describe("VGL-C012 RPCs disagree", () => {
  it("is critical, makes the verdict critical and names the account", async () => {
    const { mismatches, gaps } = await crossCheckAccounts(
      new FixtureRpcClient(later),
      new FixtureRpcClient(earlier),
      [{ address: BUFFER, kind: "buffer" }],
    );
    const ctx = await context({ facts: { rpcMismatches: mismatches }, gaps: [...gaps] });
    const findings = runRules(ctx);
    const c012 = findings.filter((f) => f.ruleId === "VGL-C012");
    expect(c012).toHaveLength(1);
    expect(c012[0]).toMatchObject({
      params: { account: BUFFER, kind: "buffer" },
      provenance: "rule-inference",
      severity: "critical",
    });
    expect(c012[0]?.evidence).toEqual([
      `account: ${BUFFER}`,
      "accountKind: buffer",
      `primarySha256: ${mismatches[0]?.primarySha256}`,
      `secondarySha256: ${mismatches[0]?.secondarySha256}`,
    ]);
    expect(computeVerdict(findings, ctx.gaps)).toBe("critical");
    const finding = c012[0];
    if (finding === undefined) {
      throw new Error("no finding");
    }
    expect(renderFinding(finding, "en").text).toBe(
      "6W37\u2026SfZX (upgrade buffer) has different content on your two RPC endpoints: at least one of them is out of date or not telling the truth, so what this proposal really does cannot be established",
    );
  });

  it("says which RPC does not have the account at all", async () => {
    const present = new FixtureRpcClient(later);
    const absent = new FixtureRpcClient({ ...later, accounts: new Map() });
    for (const [primary, secondary, side] of [
      [present, absent, "secondarySha256"],
      [absent, present, "primarySha256"],
    ] as const) {
      const { mismatches } = await crossCheckAccounts(primary, secondary, [
        { address: BUFFER, kind: "buffer" },
      ]);
      const [finding] = rpcDisagreement.evaluate(
        await context({ facts: { rpcMismatches: mismatches } }),
      );
      expect(finding?.evidence).toContain(`${side}: missing`);
    }
  });

  it("does not fire without a second RPC or when they agree", async () => {
    expect(rpcDisagreement.evaluate(await context())).toEqual([]);
    expect(rpcDisagreement.evaluate(await context({ facts: { rpcMismatches: [] } }))).toEqual([]);
  });
});
