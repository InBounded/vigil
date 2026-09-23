/**
 * Simulation must fail visibly. Each test starts from a real recorded fixture and injects one fault
 * (an RPC refusal or outage, a missing lookup table, empty balances, a changed pre-state read);
 * the injected fault is named in each test. Nothing here may throw: the outcome is an
 * `unavailable` result or a gap.
 */
import { type Address, address, getBase64Encoder, SolanaError } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { parseWireTransaction } from "../decoders/transaction.js";
import type { SimulationResult } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import type { FixtureData, SimulateResult } from "../rpc/index.js";
import { simulationProblem } from "../rules/catalog/warning.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import { embeddedVaultMessages } from "../test-support/embedded.js";
import { context, loadFixture } from "../test-support/rules.js";
import { buildSimulationTransaction } from "./build.js";
import { MAX_LOG_LINES, sanitizeLogs } from "./logs.js";
import { simulateRawTransaction } from "./raw.js";
import {
  loadVaultTargets,
  simulateProposal,
  simulateVaultMessage,
  type VaultMessageTarget,
} from "./vault.js";

const MULTISIG = address("4QBhBYPp8y6Mcw7UtycvG4ACuR6ThyMe97SEv87Wiy5m");
const VAULT = address("Bjv8VJdAZqtYW3cz5nfNEnVZx2WwWMA1quqgPRGVQMTp");
const RECIPIENT = address("AHBX3c5o2jKkuqc2V5nzYPrreUC66BuK55WemM74XMvy");
const SIMULATION_CONTEXT = { cluster: "mainnet" as const, labels: new Map() };

let solUsdc: FixtureData;
let target: VaultMessageTarget;
let recordedResult: SimulateResult;
beforeAll(async () => {
  solUsdc = await loadFixture("simulation-sol-usdc-transfer-current-state");
  const created = [...solUsdc.transactions.values()][0];
  if (created === undefined) {
    throw new Error("fixture incomplete");
  }
  const [embedded] = await embeddedVaultMessages(created);
  if (embedded === undefined) {
    throw new Error("fixture incomplete");
  }
  target = embedded.target;
  const recorded = [...(solUsdc.simulations?.values() ?? [])][0];
  if (recorded === undefined || !("result" in recorded)) {
    throw new Error("fixture incomplete");
  }
  recordedResult = recorded.result;
});

async function multisigOf(rpc: FixtureRpcClient) {
  return new SquadsV4Adapter(rpc).fetchMultisig(MULTISIG);
}

function withAccounts(
  data: FixtureData,
  change: (accounts: Map<Address, NonNullable<ReturnType<FixtureData["accounts"]["get"]>>>) => void,
): FixtureData {
  const accounts = new Map(data.accounts);
  change(accounts);
  return { ...data, accounts };
}

describe("unavailable simulation", () => {
  it("RPC refuses the simulation (injected -32602): unavailable, a gap, and VGL-W006", async () => {
    const rpc = new FixtureRpcClient(solUsdc);
    rpc.simulateTransaction = () =>
      Promise.reject(
        new SolanaError(-32602, { __serverMessage: "invalid transaction: too many account keys" }),
      );
    const gathered = await simulateVaultMessage(
      rpc,
      await multisigOf(rpc),
      target,
      SIMULATION_CONTEXT,
    );
    expect(gathered.result).toEqual({
      code: "rpc-refused",
      notes: [{ key: "simulation.note.snapshot", params: {} }],
      reason: "the RPC refused the simulation (-32602): invalid transaction: too many account keys",
      status: "unavailable",
    });
    expect(gathered.gaps.map((g) => g.code)).toEqual(["SIMULATION_UNAVAILABLE"]);
    const [finding] = simulationProblem.evaluate(await context({ simulation: gathered.result }));
    expect(finding?.titleKey).toBe("finding.VGL-W006.unavailable");
  });

  it("RPC unreachable while reading the current state (injected): unavailable, no exception", async () => {
    const rpc = new FixtureRpcClient(solUsdc);
    const multisig = await multisigOf(rpc);
    rpc.getMultipleAccounts = () => Promise.reject(new Error("socket hang up"));
    const gathered = await simulateVaultMessage(rpc, multisig, target, SIMULATION_CONTEXT);
    expect(gathered.result).toMatchObject({ code: "rpc-error", status: "unavailable" });
    expect(gathered.gaps.map((g) => g.code)).toEqual(["SIMULATION_UNAVAILABLE"]);
  });

  it("a lookup table that no longer exists (removed from the real batch fixture): accounts unresolved, per item", async () => {
    const data = await loadFixture("simulation-batch-usdc-current-state");
    const table = address("DZboAojTvNwYbhW5rCARYLnWSKNumnd4khQG63aCxTfR");
    const rpc = new FixtureRpcClient(withAccounts(data, (accounts) => accounts.delete(table)));
    const bundle = await new SquadsV4Adapter(rpc).fetchProposalBundle(
      address("81S2mzdgrTGVjHHiJGiN2bCt8hjaiBvoNqVmYyRVzuJf"),
      2270n,
    );
    const targets = await loadVaultTargets(rpc, bundle);
    const { outcome, gaps } = await simulateProposal(
      rpc,
      bundle.multisig,
      targets,
      "batch",
      SIMULATION_CONTEXT,
    );
    if (outcome?.status !== "batch") {
      throw new Error("expected a batch");
    }
    expect(
      outcome.items.map((item) => [
        item.status,
        item.status === "unavailable" && item.code,
        item.batchItem,
      ]),
    ).toEqual([
      ["unavailable", "accounts-unresolved", 1],
      ["unavailable", "accounts-unresolved", 2],
    ]);
    expect(gaps.map((g) => g.message)).toEqual([
      `simulation of batch item 1 could not be run: address lookup table does not exist (${table})`,
      `simulation of batch item 2 could not be run: address lookup table does not exist (${table})`,
    ]);
  });

  it("nobody can pay the fee (vault and members emptied): unavailable, not a guess", async () => {
    const rpc = new FixtureRpcClient(solUsdc);
    const multisig = await multisigOf(rpc);
    const empty = new FixtureRpcClient(
      withAccounts(solUsdc, (accounts) => {
        for (const key of [VAULT, ...multisig.members.map((m) => m.key)]) {
          accounts.delete(key);
        }
      }),
    );
    const gathered = await simulateVaultMessage(empty, multisig, target, SIMULATION_CONTEXT);
    expect(gathered.result).toMatchObject({ code: "no-fee-payer", status: "unavailable" });
  });

  it("a transaction over the size limit is not sent", () => {
    const parsed = parseWireTransaction(
      getBase64Encoder().encode([...(solUsdc.simulations?.keys() ?? [])][0] ?? ""),
    );
    const key = (i: number) => parsed.message.compiled.staticAccounts[i] ?? VAULT;
    const transfer = {
      accounts: [
        { address: key(0), role: 3 },
        { address: key(1), role: 1 },
      ],
      data: new Uint8Array(900),
      programAddress: address("11111111111111111111111111111111"),
    };
    const built = buildSimulationTransaction({
      feePayer: VAULT,
      instructions: [transfer, transfer],
      lookupTables: {},
    });
    expect(built).toMatchObject({ code: "too-large", ok: false });
    expect(built.ok === false && built.reason).toMatch(
      /^the transaction would be \d+ bytes, above the 1232-byte limit for simulation$/,
    );
  });
});

describe("gaps next to a successful simulation", () => {
  it("the RPC omits post-state accounts (injected): success with no changes, plus a gap and a note", async () => {
    const rpc = new FixtureRpcClient(solUsdc);
    const replay = rpc.simulateTransaction.bind(rpc);
    rpc.simulateTransaction = async (tx, options) => ({
      ...(await replay(tx, options)),
      accounts: null,
    });
    const gathered = await simulateVaultMessage(
      rpc,
      await multisigOf(rpc),
      target,
      SIMULATION_CONTEXT,
    );
    expect(gathered.result).toMatchObject({ balanceChanges: [], status: "success" });
    expect((gathered.result as SimulationResult).notes.map((n) => n.key)).toContain(
      "simulation.note.balancesNotReported",
    );
    expect(gathered.gaps.map((g) => g.code)).toEqual(["SIMULATION_BALANCES_INCOMPLETE"]);
  });

  it("the pre-state read disagrees with the RPC's own preBalances (recipient changed by 1 lamport): a gap, values not replaced", async () => {
    const real = solUsdc.accounts.get(RECIPIENT);
    if (real === undefined) {
      throw new Error("fixture incomplete");
    }
    const rpc = new FixtureRpcClient(
      withAccounts(solUsdc, (accounts) =>
        accounts.set(RECIPIENT, { ...real, lamports: real.lamports + 1n }),
      ),
    );
    const gathered = await simulateVaultMessage(
      rpc,
      await multisigOf(rpc),
      target,
      SIMULATION_CONTEXT,
    );
    expect(gathered.gaps).toEqual([
      expect.objectContaining({ address: RECIPIENT, code: "SIMULATION_PRESTATE_MISMATCH" }),
    ]);
    const change =
      gathered.result.status === "success"
        ? gathered.result.balanceChanges.find((c) => c.account === RECIPIENT && c.asset === "SOL")
        : undefined;
    expect(change?.pre).toBe(2_506_561n);
  });

  it("the vault cannot pay the fee (vault emptied): an Execute member pays, and the note says why", async () => {
    const rpc = new FixtureRpcClient(solUsdc);
    const multisig = await multisigOf(rpc);
    const noVault = new FixtureRpcClient(
      withAccounts(solUsdc, (accounts) => accounts.delete(VAULT)),
    );
    // The member-paid transaction was never recorded; answer it with the recorded simulation.
    noVault.simulateTransaction = () => Promise.resolve(recordedResult);
    const gathered = await simulateVaultMessage(noVault, multisig, target, SIMULATION_CONTEXT);
    const member = multisig.members.find((m) => m.permissions.includes("Execute"))?.key;
    expect(gathered.result).toMatchObject({ feePayer: { source: "member" } });
    expect(gathered.result.notes).toContainEqual({
      key: "simulation.note.feePayerMember",
      params: { member: expect.any(String), reason: "vaultBalance", vault: VAULT },
    });
    expect(member).toBeDefined();
  });

  it("a message signer that is neither the vault nor an ephemeral PDA must really sign: noted", async () => {
    const rpc = new FixtureRpcClient(solUsdc);
    // Real message with one more account marked as signer (never recorded; answered with the
    // recorded simulation): Squads cannot sign for it, so a real execution needs its signature.
    rpc.simulateTransaction = () => Promise.resolve(recordedResult);
    const extra = target.message.staticAccounts[1];
    const widened = {
      ...target,
      message: { ...target.message, numSigners: 2, numWritableSigners: 2 },
    };
    const gathered = await simulateVaultMessage(
      rpc,
      await multisigOf(rpc),
      widened,
      SIMULATION_CONTEXT,
    );
    expect(gathered.result.notes).toContainEqual({
      key: "simulation.note.extraSigner",
      params: { signer: extra },
    });
  });

  it("a mint that cannot be read and is not in the registry: base units with a gap", async () => {
    const data = await loadFixture("simulation-opaque-withdrawal-current-state");
    const mint = address("5Uzafw84V9rCTmYULqdJA115K6zHP16vR15zrcqa6r6C");
    const rpc = new FixtureRpcClient(withAccounts(data, (accounts) => accounts.delete(mint)));
    const bundle = await new SquadsV4Adapter(rpc).fetchProposalBundle(
      address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt"),
      352n,
    );
    const { outcome, gaps } = await simulateProposal(
      rpc,
      bundle.multisig,
      await loadVaultTargets(rpc, bundle),
      "vault",
      SIMULATION_CONTEXT,
    );
    expect(gaps).toEqual([
      expect.objectContaining({ address: mint, code: "TOKEN_DECIMALS_UNKNOWN" }),
    ]);
    expect(
      outcome?.status === "success" &&
        outcome.balanceChanges.every((c) => c.decimals === undefined),
    ).toBe(true);
  });

  it("config proposals are not simulated", async () => {
    const rpc = new FixtureRpcClient(solUsdc);
    expect(
      await simulateProposal(rpc, await multisigOf(rpc), [], "config", SIMULATION_CONTEXT),
    ).toEqual({ gaps: [] });
  });
});

describe("base64 mode", () => {
  it("simulates a real transaction as-is; its own fee payer pays; the failure is reported", async () => {
    const data = await loadFixture("simulation-raw-usdc-transfer-current-state");
    const tx = [...data.transactions.values()][0];
    if (tx === undefined) {
      throw new Error("fixture incomplete");
    }
    const gathered = await simulateRawTransaction(
      new FixtureRpcClient(data),
      tx.transactionBase64,
      SIMULATION_CONTEXT,
    );
    expect(gathered.result).toMatchObject({
      error: '{"InstructionError":["2",{"Custom":"1"}]}',
      feePayer: { address: "EmpaqxdFbQU8CoCFXCL2WiEksm8PvYksihocVZuq9p1s", source: "transaction" },
      status: "failed",
    });
    expect(gathered.result.notes).toEqual([
      { key: "simulation.note.snapshot", params: {} },
      {
        key: "simulation.note.feePayerTransaction",
        params: { feePayer: "EmpaqxdFbQU8CoCFXCL2WiEksm8PvYksihocVZuq9p1s" },
      },
    ]);
    expect(gathered.result.status === "failed" && gathered.result.logs).toContain(
      'Program log: Memo (len 44): "cc-69a24867-2d57-43bb-a2ce-f76b8461c8d5:open"',
    );
  });
});

describe("sanitizeLogs", () => {
  it("keeps 200 lines of at most 512 characters, sanitized", () => {
    const many = Array.from({ length: 250 }, (_, i) => `Program log: line ${i}`);
    const logs = sanitizeLogs(many);
    expect(logs.lines).toHaveLength(MAX_LOG_LINES);
    expect(logs).toMatchObject({ totalLines: 250, truncated: true });
    const long = sanitizeLogs(["x".repeat(600), "Program log: pay\u202Eevil"]);
    expect(long.lines[0]).toHaveLength(512);
    expect(long.lines[1]).toBe("Program log: payevil");
    expect(long.truncated).toBe(true);
    expect(sanitizeLogs(null)).toEqual({ lines: [], totalLines: 0, truncated: false });
  });
});
