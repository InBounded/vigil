import { type Address, isSolanaError } from "@solana/kit";
import { annotateInstructions } from "../annotate.js";
import type { CriticalAccount } from "../crosscheck/index.js";
import { crossCheckAccounts } from "../crosscheck/index.js";
import { decodeMessageWithLookups } from "../decoders/decode.js";
import { DecodeError } from "../decoders/errors.js";
import { decodeRawTransaction } from "../decoders/transaction.js";
import type { IdlCache } from "../idl/fetch.js";
import type { Clock } from "../io/clock.js";
import type { HttpClient } from "../io/http.js";
import { buildLabels } from "../labels/labels.js";
import {
  gatherProgramFacts,
  invokedPrograms,
  upgradeBuffers,
  upgradedPrograms,
} from "../programs/gather.js";
import { addVerification, VerificationCache } from "../programs/verification.js";
import type {
  AnalysisGap,
  AnalysisReport,
  ConfigAction,
  DecodedInstruction,
  ProgramInfo,
  ProposalSummary,
  SimulationOutcome,
} from "../report.js";
import { detectCluster } from "../rpc/cluster.js";
import type { Cluster, RpcClient } from "../rpc/types.js";
import { createRuleContext } from "../rules/context.js";
import { computeVerdict, runRules } from "../rules/engine.js";
import { resolveRuleOptions } from "../rules/options.js";
import type { RuleFacts, RuleOptions } from "../rules/types.js";
import { simulateRawTransaction } from "../simulate/raw.js";
import {
  loadVaultTargets,
  SimulationTargetError,
  simulateProposal,
  type VaultMessageTarget,
} from "../simulate/vault.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import { toConfigAction } from "../squads/config-actions.js";
import { matchesDiscriminator, toEncodedAccount } from "../squads/decode.js";
import { NotASquadsMultisigError } from "../squads/errors.js";
import {
  CONFIG_TRANSACTION_DISCRIMINATOR,
  decodeConfigTransaction,
} from "../squads/generated/accounts/configTransaction.js";
import { getVaultPda } from "../squads/pda.js";
import type { SquadsMultisigSummary, SquadsProposalBundle } from "../squads/types.js";
import { gatherTransferBalances } from "./balances.js";
import { AnalysisError, rpcFailure } from "./errors.js";
import { gatherRecentDestinations } from "./history.js";

/** What an analysis reads through. Nothing else performs I/O. */
export interface AnalysisDependencies {
  readonly rpc: RpcClient;
  /** Host of `rpc` (see `rpcHostOf`); the only part of the endpoint a report may show. */
  readonly rpcHost: string;
  /** Used only for the program-verification API, and only when `verification` is on. */
  readonly http: HttpClient;
  readonly clock: Clock;
  /** A second, independent RPC to compare the critical accounts with (VGL-C012). */
  readonly crossCheckRpc?: RpcClient;
  readonly idlCache?: IdlCache;
  /** Shared between analyses (e.g. `vigil list`) so each program is asked about once. */
  readonly verificationCache?: VerificationCache;
}

/** Steps reported through `onProgress`, in the order they run. */
export type AnalysisStep =
  | "cluster"
  | "proposal"
  | "decode"
  | "annotate"
  | "simulate"
  | "programs"
  | "verification"
  | "balances"
  | "history"
  | "cross-check"
  | "rules";

export interface AnalysisOptions {
  /** Simulate the transaction. Off: a `SIMULATION_DISABLED` gap. @defaultValue true */
  readonly simulate?: boolean;
  /** Ask the program-verification API. Off: a `PROGRAM_VERIFICATION_DISABLED` gap. @defaultValue true */
  readonly verification?: boolean;
  readonly rules?: RuleOptions;
  /** The user's own labels (already sanitized, see `parseUserLabels`). */
  readonly userLabels?: ReadonlyMap<Address, string>;
  readonly onProgress?: (step: AnalysisStep) => void;
}

/**
 * The host of an RPC URL, for `AnalysisReport.rpcHost`: never the path, query or credentials,
 * which may hold an API key.
 */
export function rpcHostOf(url: string): string {
  try {
    return new URL(url).host || "unknown";
  } catch {
    return "invalid-url";
  }
}

/**
 * Analyses one Squads v4 proposal: reads the multisig, the proposal and its transaction, decodes
 * what it would execute, simulates it, gathers what the rules need and runs them. Throws
 * `AnalysisError` only when there is nothing to analyse (not a multisig, no such transaction) or
 * the RPC fails before anything could be read; every later failure is a gap in the report.
 */
export async function analyzeProposal(
  deps: AnalysisDependencies,
  input: { readonly multisig: Address; readonly transactionIndex: bigint },
  options: AnalysisOptions = {},
): Promise<AnalysisReport> {
  const progress = options.onProgress ?? (() => undefined);
  const ruleOptions = resolveRuleOptions(options.rules);
  const { rpc } = deps;

  progress("cluster");
  const { cluster, contextSlot } = await readCluster(rpc);

  progress("proposal");
  const adapter = new SquadsV4Adapter(rpc);
  const multisig = await fetchMultisig(adapter, input.multisig);
  if (input.transactionIndex < 1n || input.transactionIndex > multisig.transactionIndex) {
    throw new AnalysisError(
      "TRANSACTION_NOT_FOUND",
      multisig.transactionIndex === 0n
        ? `multisig ${input.multisig} has no transactions yet`
        : `multisig ${input.multisig} has transactions 1 to ${multisig.transactionIndex}; there is no transaction ${input.transactionIndex}`,
    );
  }
  const bundle = await fetchBundle(adapter, input.multisig, input.transactionIndex);

  progress("decode");
  const gaps: AnalysisGap[] = [];
  const idl = deps.idlCache === undefined ? {} : { idl: { cache: deps.idlCache } };
  let instructions: DecodedInstruction[] = [];
  let configActions: ConfigAction[] | undefined;
  let targets: readonly VaultMessageTarget[] = [];
  const lookupTables = new Set<Address>();
  if (bundle.transactionKind === "config") {
    configActions = await readConfigActions(rpc, bundle.transactionAddress);
  } else {
    try {
      targets = await loadVaultTargets(rpc, bundle);
    } catch (error) {
      if (error instanceof SimulationTargetError) {
        throw new AnalysisError("TRANSACTION_INVALID", error.message);
      }
      throw rpcFailure("the proposal's transaction could not be read", error);
    }
    for (const target of targets) {
      const decoded = await decodeMessageWithLookups(rpc, target.message, idl);
      gaps.push(...decoded.gaps);
      for (const table of decoded.lookupTables) {
        lookupTables.add(table.address);
      }
      instructions.push(
        ...decoded.instructions.map((instruction) =>
          target.batchItem === undefined
            ? instruction
            : { ...instruction, batchItem: target.batchItem },
        ),
      );
    }
  }
  const vaultIndex = targets[0]?.vaultIndex;

  progress("annotate");
  const labelMultisig = {
    address: multisig.address,
    members: multisig.members.map((member) => member.key),
    ...(vaultIndex === undefined ? {} : { vaultIndex }),
  };
  const userLabels = options.userLabels === undefined ? {} : { userLabels: options.userLabels };
  const annotated = await annotateInstructions(rpc, instructions, {
    cluster,
    multisig: labelMultisig,
    ...userLabels,
  });
  instructions = annotated.instructions;
  gaps.push(...annotated.gaps);

  let simulation: SimulationOutcome | undefined;
  if (bundle.transactionKind !== "config") {
    if (options.simulate === false) {
      gaps.push(simulationDisabledGap());
    } else {
      progress("simulate");
      const labels = await buildLabels({ cluster, multisig: labelMultisig, ...userLabels });
      const simulated = await simulateProposal(rpc, multisig, targets, bundle.transactionKind, {
        cluster,
        labels,
      });
      simulation = simulated.outcome;
      gaps.push(...simulated.gaps);
    }
  }

  const vaults = await vaultsOf(multisig.address, vaultIndex);
  const gathered = await gatherFacts(deps, options, ruleOptions, progress, {
    instructions,
    simulation,
    vaults,
  });
  gaps.push(...gathered.gaps);

  let recentDestinations: ReadonlySet<Address> | undefined;
  if (ruleOptions.historyDepth > 0) {
    progress("history");
    const vault = vaults.find((v) => v.index === (vaultIndex ?? 0))?.address;
    if (vault !== undefined) {
      const history = await gatherRecentDestinations(rpc, {
        depth: ruleOptions.historyDepth,
        instructions,
        multisig: multisig.address,
        vault,
      });
      recentDestinations = history.destinations;
      gaps.push(...history.gaps);
    }
  }

  const critical: CriticalAccount[] = [
    { address: multisig.address, kind: "multisig" },
    { address: bundle.transactionAddress, kind: "transaction" },
    ...(bundle.proposal === null
      ? []
      : [{ address: bundle.proposal.address, kind: "proposal" as const }]),
    ...(bundle.batchTransactions ?? []).map((item) => ({
      address: item.address,
      kind: "batch-transaction" as const,
    })),
    ...[...lookupTables].map((address) => ({ address, kind: "lookup-table" as const })),
    ...programAccounts(gathered.programs, gathered.buffers),
  ];
  const crossCheck = await runCrossCheck(deps, critical, progress);
  gaps.push(...crossCheck.gaps, ...rpc.limitations());

  progress("rules");
  const proposal: ProposalSummary = {
    isStale: input.transactionIndex <= multisig.staleTransactionIndex,
    proposalAddress: bundle.proposal?.address ?? null,
    status: bundle.proposal?.status ?? null,
    transactionAddress: bundle.transactionAddress,
    transactionIndex: input.transactionIndex,
    votes: bundle.proposal?.votes ?? null,
    ...(vaultIndex === undefined ? {} : { vaultIndex }),
    ...(bundle.batchTransactions === undefined
      ? {}
      : { batchItems: bundle.batchTransactions.map((item) => item.index) }),
  };
  const reportInput = {
    kind: "squads-proposal" as const,
    multisig: input.multisig,
    transactionIndex: input.transactionIndex,
  };
  const facts: RuleFacts = {
    balances: gathered.balances,
    buffers: gathered.buffers,
    rpcMismatches: crossCheck.mismatches,
    ...(recentDestinations === undefined ? {} : { recentDestinations }),
  };
  const context = await createRuleContext({
    cluster,
    facts,
    gaps,
    input: reportInput,
    instructions,
    multisig,
    now: BigInt(Math.floor(deps.clock.now() / 1000)),
    programs: gathered.programs,
    proposal: bundle.proposal,
    tokens: annotated.tokens,
    transactionKind: bundle.transactionKind,
    ...(options.rules === undefined ? {} : { options: options.rules }),
    ...(configActions === undefined ? {} : { configActions }),
    ...(simulation === undefined ? {} : { simulation }),
    ...(vaultIndex === undefined ? {} : { vaultIndex }),
  });
  const findings = runRules(context);

  return {
    cluster,
    completeness: { complete: gaps.length === 0, gaps },
    contextSlot,
    findings,
    generatedAt: new Date(deps.clock.now()).toISOString(),
    input: reportInput,
    instructions,
    multisig,
    programs: gathered.programs,
    proposal,
    rpcHost: deps.rpcHost,
    schemaVersion: 1,
    tokens: annotated.tokens,
    transactionKind: bundle.transactionKind,
    verdict: computeVerdict(findings, gaps),
    ...(configActions === undefined ? {} : { configActions }),
    ...(simulation === undefined ? {} : { simulation }),
  };
}

/** Largest raw transaction accepted, in base64 characters (a v1 transaction is at most 4,096 bytes). */
export const MAX_RAW_TRANSACTION_BASE64_LENGTH = 4 * Math.ceil(4096 / 3);

/**
 * Analyses a base64 wire transaction (legacy, v0 or v1) exactly as given: decodes it, simulates it
 * with its own fee payer, gathers what the rules need and runs them. Throws `AnalysisError` for
 * input that is not a valid transaction, or when the RPC cannot be reached at all.
 */
export async function analyzeRawTransaction(
  deps: AnalysisDependencies,
  base64: string,
  options: AnalysisOptions = {},
): Promise<AnalysisReport> {
  const progress = options.onProgress ?? (() => undefined);
  const ruleOptions = resolveRuleOptions(options.rules);
  const { rpc } = deps;
  const text = base64.trim();
  if (text.length > MAX_RAW_TRANSACTION_BASE64_LENGTH) {
    throw new AnalysisError(
      "INVALID_TRANSACTION",
      `the input is ${text.length} base64 characters; a Solana transaction is at most ${MAX_RAW_TRANSACTION_BASE64_LENGTH}`,
    );
  }

  progress("cluster");
  const { cluster, contextSlot } = await readCluster(rpc);

  progress("decode");
  const idl = deps.idlCache === undefined ? {} : { idl: { cache: deps.idlCache } };
  let decoded: Awaited<ReturnType<typeof decodeRawTransaction>>;
  try {
    decoded = await decodeRawTransaction(rpc, text, idl);
  } catch (error) {
    if (error instanceof DecodeError) {
      throw new AnalysisError("INVALID_TRANSACTION", error.message);
    }
    throw rpcFailure("the transaction's lookup tables could not be read", error);
  }
  const gaps: AnalysisGap[] = [...decoded.gaps];

  progress("annotate");
  const userLabels = options.userLabels === undefined ? {} : { userLabels: options.userLabels };
  const annotated = await annotateInstructions(rpc, decoded.instructions, {
    cluster,
    ...userLabels,
  });
  const instructions = annotated.instructions;
  gaps.push(...annotated.gaps);

  let simulation: SimulationOutcome | undefined;
  if (options.simulate === false) {
    gaps.push(simulationDisabledGap());
  } else {
    progress("simulate");
    const labels = await buildLabels({ cluster, ...userLabels });
    const simulated = await simulateRawTransaction(rpc, text, { cluster, labels });
    simulation = simulated.result;
    gaps.push(...simulated.gaps);
  }

  const gathered = await gatherFacts(deps, options, ruleOptions, progress, {
    instructions,
    simulation,
    vaults: [],
  });
  gaps.push(...gathered.gaps);

  const critical: CriticalAccount[] = [
    ...decoded.lookupTables.map((table) => ({
      address: table.address,
      kind: "lookup-table" as const,
    })),
    ...programAccounts(gathered.programs, gathered.buffers),
  ];
  const crossCheck = await runCrossCheck(deps, critical, progress);
  gaps.push(...crossCheck.gaps, ...rpc.limitations());

  progress("rules");
  const reportInput = { kind: "raw-transaction" as const, sha256: decoded.sha256 };
  const context = await createRuleContext({
    cluster,
    facts: {
      balances: gathered.balances,
      buffers: gathered.buffers,
      rpcMismatches: crossCheck.mismatches,
    },
    feePayer: decoded.feePayer,
    gaps,
    input: reportInput,
    instructions,
    now: BigInt(Math.floor(deps.clock.now() / 1000)),
    programs: gathered.programs,
    tokens: annotated.tokens,
    ...(options.rules === undefined ? {} : { options: options.rules }),
    ...(simulation === undefined ? {} : { simulation }),
    ...(decoded.transactionConfig === undefined
      ? {}
      : { transactionConfig: decoded.transactionConfig }),
  });
  const findings = runRules(context);

  return {
    cluster,
    completeness: { complete: gaps.length === 0, gaps },
    contextSlot,
    findings,
    generatedAt: new Date(deps.clock.now()).toISOString(),
    input: reportInput,
    instructions,
    programs: gathered.programs,
    rawTransaction: {
      feePayer: decoded.feePayer,
      signatureCount: decoded.signatureCount,
      version: decoded.version,
      ...(decoded.transactionConfig === undefined
        ? {}
        : { transactionConfig: decoded.transactionConfig }),
    },
    rpcHost: deps.rpcHost,
    schemaVersion: 1,
    tokens: annotated.tokens,
    verdict: computeVerdict(findings, gaps),
    ...(simulation === undefined ? {} : { simulation }),
  };
}

async function readCluster(rpc: RpcClient): Promise<{ cluster: Cluster; contextSlot: bigint }> {
  try {
    const genesisHash = await rpc.getGenesisHash();
    const contextSlot = await rpc.getSlot();
    return { cluster: detectCluster(genesisHash), contextSlot };
  } catch (error) {
    throw rpcFailure("the RPC endpoint could not be queried", error);
  }
}

async function fetchMultisig(
  adapter: SquadsV4Adapter,
  address: Address,
): Promise<SquadsMultisigSummary> {
  try {
    return await adapter.fetchMultisig(address);
  } catch (error) {
    if (error instanceof NotASquadsMultisigError) {
      throw new AnalysisError("NOT_A_MULTISIG", error.message);
    }
    throw rpcFailure("the multisig account could not be read", error);
  }
}

async function fetchBundle(
  adapter: SquadsV4Adapter,
  multisig: Address,
  transactionIndex: bigint,
): Promise<SquadsProposalBundle> {
  try {
    return await adapter.fetchProposalBundle(multisig, transactionIndex);
  } catch (error) {
    if (isSolanaError(error) || !(error instanceof Error)) {
      throw rpcFailure("the proposal could not be read", error);
    }
    // The adapter's own errors: no account at that index (closed after execution or
    // cancellation, rent reclaimed), or one that is not a Squads transaction.
    throw new AnalysisError(
      error.message.startsWith("No transaction found")
        ? "TRANSACTION_NOT_FOUND"
        : "TRANSACTION_INVALID",
      error.message,
    );
  }
}

async function readConfigActions(rpc: RpcClient, address: Address): Promise<ConfigAction[]> {
  let account: Awaited<ReturnType<RpcClient["getAccountInfo"]>>["value"];
  try {
    account = (await rpc.getAccountInfo(address)).value;
  } catch (error) {
    throw rpcFailure("the config transaction could not be read", error);
  }
  if (account === null) {
    throw new AnalysisError(
      "TRANSACTION_NOT_FOUND",
      `config transaction ${address} does not exist`,
    );
  }
  const encoded = toEncodedAccount(address, account);
  if (!matchesDiscriminator(encoded.data, CONFIG_TRANSACTION_DISCRIMINATOR)) {
    throw new AnalysisError("TRANSACTION_INVALID", `${address} is not a ConfigTransaction`);
  }
  return decodeConfigTransaction(encoded).data.actions.map(toConfigAction);
}

/** The vaults program upgrade authorities are compared with: the proposal's own and vault 0. */
async function vaultsOf(
  multisig: Address,
  vaultIndex: number | undefined,
): Promise<{ address: Address; index: number }[]> {
  const indices = [...new Set([0, ...(vaultIndex === undefined ? [] : [vaultIndex])])];
  return Promise.all(
    indices.map(async (index) => ({
      address: (await getVaultPda({ index, multisigPda: multisig }))[0],
      index,
    })),
  );
}

function simulationDisabledGap(): AnalysisGap {
  return {
    code: "SIMULATION_DISABLED",
    message: "simulation was turned off, so the balance changes are not known",
  };
}

interface GatheredFacts {
  readonly programs: readonly ProgramInfo[];
  readonly buffers: NonNullable<RuleFacts["buffers"]>;
  readonly balances: NonNullable<RuleFacts["balances"]>;
  readonly gaps: readonly AnalysisGap[];
}

/** Program information, verification status and the balances transfers draw on. */
async function gatherFacts(
  deps: AnalysisDependencies,
  options: AnalysisOptions,
  ruleOptions: ReturnType<typeof resolveRuleOptions>,
  progress: (step: AnalysisStep) => void,
  input: {
    readonly instructions: readonly DecodedInstruction[];
    readonly simulation: SimulationOutcome | undefined;
    readonly vaults: readonly { readonly address: Address; readonly index: number }[];
  },
): Promise<GatheredFacts> {
  const { instructions } = input;
  progress("programs");
  const facts = await gatherProgramFacts(deps.rpc, {
    buffers: upgradeBuffers(instructions),
    programs: [
      ...invokedPrograms(instructions, innerPrograms(input.simulation)),
      ...upgradedPrograms(instructions),
    ],
    vaults: input.vaults,
  });
  progress("verification");
  const verified = await addVerification(facts.programs, {
    cache: deps.verificationCache ?? new VerificationCache(deps.clock),
    enabled: options.verification !== false,
    http: deps.http,
  });
  progress("balances");
  const balances = await gatherTransferBalances(
    deps.rpc,
    instructions,
    ruleOptions.largeTransferAbsolute,
  );
  return {
    balances: balances.balances,
    buffers: facts.buffers,
    gaps: [...facts.gaps, ...verified.gaps, ...balances.gaps],
    programs: verified.programs,
  };
}

function innerPrograms(outcome: SimulationOutcome | undefined): Address[] {
  if (outcome === undefined) {
    return [];
  }
  const results = outcome.status === "batch" ? outcome.items : [outcome];
  return results.flatMap((result) =>
    result.status === "unavailable" ? [] : [...(result.innerPrograms ?? [])],
  );
}

/** ProgramData accounts of the programs and the upgrade buffers: critical for the cross-check. */
function programAccounts(
  programs: readonly ProgramInfo[],
  buffers: ReadonlyMap<Address, unknown>,
): CriticalAccount[] {
  return [
    ...programs.flatMap((program) =>
      program.programData === undefined
        ? []
        : [{ address: program.programData, kind: "programdata" as const }],
    ),
    ...[...buffers.keys()].map((address) => ({ address, kind: "buffer" as const })),
  ];
}

async function runCrossCheck(
  deps: AnalysisDependencies,
  accounts: readonly CriticalAccount[],
  progress: (step: AnalysisStep) => void,
): Promise<{ mismatches: NonNullable<RuleFacts["rpcMismatches"]>; gaps: readonly AnalysisGap[] }> {
  if (deps.crossCheckRpc === undefined) {
    return { gaps: [], mismatches: [] };
  }
  progress("cross-check");
  return crossCheckAccounts(deps.rpc, deps.crossCheckRpc, accounts);
}
