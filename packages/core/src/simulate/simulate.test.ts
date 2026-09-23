/**
 * Simulation (Phase 5.1) replayed from real recorded mainnet simulations. Each fixture was made by
 * running these same gatherers live through `RecordingRpcClient` (`scripts/capture-gatherers.ts`);
 * its balances are the chain's state at capture time, not at the proposal's original execution.
 */
import { type Address, address, getBase64Encoder } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { parseWireTransaction } from "../decoders/transaction.js";
import { renderFinding, renderSimulationNotes } from "../i18n/render.js";
import { buildLabels } from "../labels/labels.js";
import type { BatchSimulation, SimulationOutcome, SimulationResult } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import type { FixtureData } from "../rpc/index.js";
import { simulationProblem, unexpectedBalanceChanges } from "../rules/catalog/warning.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import { context, loadFixture, proposalFixtureContext } from "../test-support/rules.js";
import { readTokenBalance } from "./balances.js";
import { loadVaultTargets, simulateProposal } from "./vault.js";

async function simulateFixtureProposal(data: FixtureData, multisig: Address, index: bigint) {
  const rpc = new FixtureRpcClient(data);
  const bundle = await new SquadsV4Adapter(rpc).fetchProposalBundle(multisig, index);
  const targets = await loadVaultTargets(rpc, bundle);
  const labels = await buildLabels({
    cluster: "mainnet",
    multisig: {
      address: multisig,
      members: bundle.multisig.members.map((m) => m.key),
      ...(targets[0] === undefined ? {} : { vaultIndex: targets[0].vaultIndex }),
    },
  });
  const simulation = await simulateProposal(rpc, bundle.multisig, targets, bundle.transactionKind, {
    cluster: "mainnet",
    labels,
  });
  return { bundle, rpc, simulation, targets };
}

function single(outcome: SimulationOutcome | undefined): SimulationResult {
  if (outcome === undefined || outcome.status === "batch") {
    throw new Error("expected a single simulation result");
  }
  return outcome;
}

const THREE_GJE = address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt");
const VAULT_3GJE = address("7rzEKejyAXJXMkGfRhMV9Vg1k7tFznBBEFu3sfLNz8LC");
const MINT_5UZ = address("5Uzafw84V9rCTmYULqdJA115K6zHP16vR15zrcqa6r6C");

describe("vault proposal simulated against current state (opaque withdrawal, #352)", () => {
  let data: FixtureData;
  beforeAll(async () => {
    data = await loadFixture("simulation-opaque-withdrawal-current-state");
  });

  it("reports token balance changes exact to the smallest unit, grouped by holder", async () => {
    const { simulation } = await simulateFixtureProposal(data, THREE_GJE, 352n);
    const result = single(simulation.outcome);
    expect(simulation.gaps).toEqual([]);
    if (result.status !== "success") {
      throw new Error(`expected success, got ${result.status}`);
    }
    expect(result.feePayer).toEqual({ address: VAULT_3GJE, source: "vault" });
    expect(result.slot).toBe(449607215n);
    expect(result.fee).toBe(5000n);
    expect(result.innerPrograms).toEqual(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    expect(result.balanceChanges).toEqual([
      {
        account: "ACvziQsaxmLQbhFN6oHBCYByMNGSsiV9NggWBJUrQQaD",
        asset: MINT_5UZ,
        decimals: 9,
        owner: "5ofbFoCRV2XcNZx5gSbFj92iooJ6iSeTGE3S7stoZuwC",
        post: 33_792_826_216_902n,
        pre: 33_793_826_216_902n,
      },
      {
        account: "CRCRKWes9CjQFpvQxJmFUBeiqbfjJBaZadosK45YF1Np",
        asset: MINT_5UZ,
        decimals: 9,
        holderLabel: { key: "label.vault", params: { index: "0" }, source: "multisig" },
        owner: VAULT_3GJE,
        post: 69_325_606_821n,
        pre: 68_325_606_821n,
      },
    ]);
    // The vault paid the 5,000-lamport fee and nothing else: with the fee excluded its SOL does
    // not change, so it is not listed.
    expect(result.notes.map((n) => n.key)).toEqual([
      "simulation.note.snapshot",
      "simulation.note.feeExcluded",
    ]);
  });

  it("agrees with the RPC's own pre/post token balances recorded in the same response", async () => {
    const recorded = [...(data.simulations?.values() ?? [])];
    expect(recorded).toHaveLength(1);
    const response = recorded[0];
    if (response === undefined || !("result" in response)) {
      throw new Error("expected a recorded result");
    }
    const { result } = response;
    const keys = getAccountKeys([...(data.simulations?.keys() ?? [])][0] ?? "");
    const delta = new Map<string, bigint>();
    for (const [sign, list] of [
      [-1n, result.preTokenBalances],
      [1n, result.postTokenBalances],
    ] as const) {
      for (const entry of list ?? []) {
        const key = keys[entry.accountIndex] ?? "?";
        delta.set(key, (delta.get(key) ?? 0n) + sign * entry.amount);
      }
    }
    expect(Object.fromEntries(delta)).toEqual({
      ACvziQsaxmLQbhFN6oHBCYByMNGSsiV9NggWBJUrQQaD: -1_000_000_000n,
      CRCRKWes9CjQFpvQxJmFUBeiqbfjJBaZadosK45YF1Np: 1_000_000_000n,
    });
    // And the post-state accounts decode to the same amounts Vigil reports.
    const post = result.accounts?.flatMap((a) => (a === null ? [] : [readTokenBalance(a)])) ?? [];
    expect(post.filter((t) => t !== null).map((t) => t?.amount)).toEqual(
      expect.arrayContaining([33_792_826_216_902n, 69_325_606_821n]),
    );
  });

  it("fires VGL-W007: the only instruction that could explain the changes is opaque", async () => {
    const { simulation } = await simulateFixtureProposal(data, THREE_GJE, 352n);
    const { context: ctx } = await proposalFixtureContext("vault-transaction", THREE_GJE, 352n, {
      ...(simulation.outcome === undefined ? {} : { simulation: simulation.outcome }),
    });
    const [finding] = unexpectedBalanceChanges.evaluate(ctx);
    expect(finding).toMatchObject({
      params: { count: "2" },
      provenance: "simulation",
      ruleId: "VGL-W007",
    });
    expect(finding?.evidence).toEqual([
      `change: ACvziQsaxmLQbhFN6oHBCYByMNGSsiV9NggWBJUrQQaD ${MINT_5UZ} 33793826216902 -> 33792826216902 (-1000000000)`,
      `change: CRCRKWes9CjQFpvQxJmFUBeiqbfjJBaZadosK45YF1Np ${MINT_5UZ} 68325606821 -> 69325606821 (1000000000)`,
    ]);
    expect(simulationProblem.evaluate(ctx)).toEqual([]);
  });
});

describe("batch proposal simulated item by item against current state (USDC, #2270)", () => {
  const MULTISIG = address("81S2mzdgrTGVjHHiJGiN2bCt8hjaiBvoNqVmYyRVzuJf");
  const MEMBER = address("2Y4xZDJegxe2wUWb1pChgRzpF6jqq3yLV8q3WekPEJPy");
  let batch: BatchSimulation;
  beforeAll(async () => {
    const data = await loadFixture("simulation-batch-usdc-current-state");
    const { simulation } = await simulateFixtureProposal(data, MULTISIG, 2270n);
    if (simulation.outcome?.status !== "batch") {
      throw new Error("expected a batch outcome");
    }
    batch = simulation.outcome;
  });

  it("simulates each item separately and says their effects are not carried over", () => {
    expect(batch.notes).toEqual([
      { key: "simulation.note.snapshot", params: {} },
      { key: "simulation.note.batchIsolated", params: { count: "2" } },
    ]);
    expect(batch.items.map((item) => [item.batchItem, item.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
    ]);
  });

  it("retries with an Execute member paying when the vault-paid simulation fails, and records it", () => {
    for (const item of batch.items) {
      if (item.status !== "failed") {
        throw new Error("expected failure");
      }
      expect(item.feePayer).toEqual({ address: MEMBER, source: "member" });
      expect(item.notes[0]).toEqual({ key: "simulation.note.snapshot", params: {} });
      expect(item.notes).toContainEqual({
        key: "simulation.note.feePayerMember",
        params: {
          member: MEMBER,
          reason: "vaultFailed",
          vault: "HH6dXisw1Lin1k8c1y2h6cWNoFopV59kHrwQAK6fZVCh",
        },
      });
      expect(item.logs).toContain("Program log: Error: insufficient funds");
    }
    expect(batch.items.map((item) => item.status === "failed" && item.error)).toEqual([
      '{"InstructionError":["1",{"Custom":"1"}]}',
      '{"InstructionError":["0",{"Custom":"1"}]}',
    ]);
  });

  it("fires VGL-W006 once per failed item, naming the item", async () => {
    const findings = simulationProblem.evaluate(
      await context({ simulation: batch, transactionKind: "batch" }),
    );
    expect(findings.map((f) => [f.titleKey, f.params.batchItem])).toEqual([
      ["finding.VGL-W006.failed", "1"],
      ["finding.VGL-W006.failed", "2"],
    ]);
    const [first] = findings;
    if (first === undefined) {
      throw new Error("no finding");
    }
    expect(renderFinding(first, "en").text).toBe(
      'Batch item 1: simulation failed: {"InstructionError":["1",{"Custom":"1"}]}',
    );
    expect(renderFinding(first, "pt-PT").text).toBe(
      'Item 1 do lote: a simulação falhou: {"InstructionError":["1",{"Custom":"1"}]}',
    );
  });

  it("always renders the snapshot note first, in both languages", () => {
    const en = renderSimulationNotes(batch, "en").map((r) => r.text);
    expect(en[0]).toBe(
      "Snapshot of one moment: this simulation shows what would happen if the transaction ran right now. Network state can change before execution, so the results shown are not a guarantee.",
    );
    expect(en).toContain(
      "Each of the 2 batch items was simulated on its own: the effects of earlier items are not carried into later ones, so a later item may behave differently when the batch really executes.",
    );
    const pt = renderSimulationNotes(batch, "pt-PT").map((r) => r.text);
    expect(pt[0]).toBe(
      "Retrato de um só momento: esta simulação mostra o que aconteceria se a transação fosse executada agora. O estado da rede pode mudar antes da execução, por isso os resultados apresentados não são uma garantia.",
    );
    // Even a result that somehow lost its notes gets the snapshot note.
    const bare = { ...batch, items: [], notes: [] };
    expect(renderSimulationNotes(bare, "en")[0]?.text).toBe(en[0]);
    expect(renderSimulationNotes(bare, "en")).toHaveLength(1);
  });
});

/** Static account keys of a recorded simulated transaction (the #352 message has no lookups). */
function getAccountKeys(base64: string): readonly Address[] {
  return parseWireTransaction(getBase64Encoder().encode(base64)).message.compiled.staticAccounts;
}
