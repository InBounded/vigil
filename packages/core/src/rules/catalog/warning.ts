import { type Address, isAddress } from "@solana/kit";
import { findRegistryProgram, REGISTRY_TOKENS } from "../../registry/index.js";
import type { AssetId, DecodedInstruction, Finding, SimulationResult } from "../../report.js";
import { type SanitizeFlag, sanitizeOnchainString } from "../../sanitize/sanitize.js";
import {
  accountByRole,
  bigintArg,
  describeAddress,
  ev,
  finding,
  isInstruction,
  isOwnAddress,
  isTokenProgram,
  PROGRAMS,
  roleText,
} from "../helpers.js";
import { looksAlike } from "../skeleton.js";
import type { Rule, RuleContext } from "../types.js";
import { type WalkedInstruction, walkInstructions } from "../walk.js";

export const opaqueInstruction: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "Programs that publish no IDL fire even when they are well known. Adding a decoder or publishing an IDL (Program Metadata) removes the warning.",
    what: "An instruction Vigil cannot decode: the program has no built-in decoder and no readable IDL, or its data does not match what the decoder expects.",
    why: "Nobody can say what an opaque instruction does from the transaction alone: it may move funds, change authorities, or do nothing at all.",
  },
  evaluate(context) {
    return walkInstructions(context.instructions)
      .filter((at) => at.instruction.decoder === "none")
      .map((at) =>
        finding(this, {
          at,
          evidence: [
            ev("program", at.instruction.programId),
            ev("programLabel", at.instruction.programLabel ?? "none"),
            ev("dataHex", at.instruction.rawDataHex),
          ],
          params: { program: at.instruction.programId },
          provenance: "rule-inference",
        }),
      );
  },
  id: "VGL-W001",
  name: "Opaque instruction",
  titleKey: "finding.VGL-W001",
  variants: [""],
};

/** Programs the transaction calls, first occurrence each; registry programs are curated and skipped. */
function calledPrograms(context: RuleContext): Map<Address, WalkedInstruction> {
  const out = new Map<Address, WalkedInstruction>();
  for (const at of walkInstructions(context.instructions)) {
    const program = at.instruction.programId;
    if (!out.has(program) && findRegistryProgram(program) === undefined) {
      out.set(program, at);
    }
  }
  return out;
}

export const unverifiedProgram: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "Many honest programs are not verified builds. Programs in Vigil's curated registry (native programs, SPL Token, Squads) are not checked. When the verification service cannot be reached the status is unknown and the analysis is also marked incomplete. When you turn verification lookups off, this rule does not fire: the report lists that choice as a gap instead.",
    what: "A program the transaction calls whose deployed code is not a verified build of public source code, or whose verification status was looked up but could not be established.",
    why: "Without a verified build, nobody can check that the deployed code matches any published source.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const [program, at] of calledPrograms(context)) {
      const verification =
        context.programs.find((p) => p.address === program)?.verification ?? "unknown";
      // `not-checked`: the user turned lookups off; that choice is a gap, not a warning per program.
      if (verification === "verified" || verification === "not-checked") {
        continue;
      }
      findings.push(
        finding(this, {
          at,
          evidence: [ev("program", program), ev("verification", verification)],
          params: { program },
          provenance: verification === "unverified" ? "external-api" : "rule-inference",
          variant: verification,
        }),
      );
    }
    return findings;
  },
  id: "VGL-W002",
  name: "Program not verified",
  titleKey: "finding.VGL-W002",
  variants: ["unverified", "unknown"],
};

export const thirdPartyUpgradeable: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "Most actively maintained protocols are upgradeable by their own team or multisig; that is expected, but it means their behaviour can change between the vote and execution. Programs in the curated registry are not checked.",
    what: "A program the transaction calls that can be upgraded by an authority other than this multisig's vaults (or your known addresses).",
    why: "Its code can be replaced after members vote and before the proposal executes, so what the program does at execution time may differ from what was reviewed.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const [program, at] of calledPrograms(context)) {
      const upgrade = context.programs.find((p) => p.address === program)?.upgrade;
      if (upgrade?.kind !== "upgradeable" || isOwnAddress(context, upgrade.authority)) {
        continue;
      }
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("program", program),
            ev("upgradeAuthority", upgrade.authority),
            ev("upgradeAuthorityIs", describeAddress(context, upgrade.authority)),
          ],
          params: { authority: upgrade.authority, program },
          provenance: "onchain",
        }),
      );
    }
    return findings;
  },
  id: "VGL-W003",
  name: "Program upgradeable by a third party",
  titleKey: "finding.VGL-W003",
  variants: [""],
};

export interface Transfer {
  readonly at: WalkedInstruction;
  readonly from: Address;
  readonly to: Address;
  readonly asset: AssetId;
  readonly amount: bigint;
  /** Amount-formatting params (`decimals`, `symbol`, `mint`, declared name). */
  readonly assetParams: Readonly<Record<string, string>>;
}

const TOKEN_PARAMS = ["mint", "decimals", "symbol", "declaredName", "declaredSymbol"];

function transfers(context: RuleContext): Transfer[] {
  return listTransfers(context.instructions);
}

/**
 * SOL and token transfers, with the account whose balance they draw on. Exported so the balance
 * gatherer reads exactly the balances VGL-W004 compares with.
 */
export function listTransfers(instructions: readonly DecodedInstruction[]): Transfer[] {
  const out: Transfer[] = [];
  for (const at of walkInstructions(instructions)) {
    const ix = at.instruction;
    const amount = bigintArg(ix, "amount");
    let from: Address | undefined;
    let to: Address | undefined;
    let asset: string | undefined;
    let assetParams: Record<string, string>;
    if (isInstruction(ix, PROGRAMS.system, "transferSol", "transferSolWithSeed")) {
      from = accountByRole(ix, "source");
      to = accountByRole(ix, "destination");
      asset = "SOL";
      assetParams = { decimals: "9", symbol: "SOL" };
    } else if (
      isTokenProgram(ix.programId) &&
      ix.decoder !== "none" &&
      (ix.name === "transfer" || ix.name === "transferChecked")
    ) {
      const params = ix.summary?.params ?? {};
      from = accountByRole(ix, "authority");
      const owner = params.destinationOwner;
      to = owner !== undefined && isAddress(owner) ? owner : accountByRole(ix, "destination");
      asset = params.mint;
      assetParams = Object.fromEntries(
        TOKEN_PARAMS.flatMap((name) => {
          const value = params[name];
          return value === undefined ? [] : [[name, value]];
        }),
      );
    } else {
      continue;
    }
    if (
      amount === undefined ||
      from === undefined ||
      to === undefined ||
      asset === undefined ||
      (asset !== "SOL" && !isAddress(asset))
    ) {
      continue;
    }
    out.push({ amount, asset, assetParams, at, from, to });
  }
  return out;
}

/** Basis points as a percentage: 1050 → `10.5`, 1000 → `10`. */
function basisPointsText(basisPoints: bigint): string {
  const fraction = (basisPoints % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction === "" ? `${basisPoints / 100n}` : `${basisPoints / 100n}.${fraction}`;
}

/** `part / whole` as a percentage with two decimals, rounded down (`whole` > 0). */
function percentText(part: bigint, whole: bigint): string {
  return basisPointsText((part * 10_000n) / whole);
}

export const largeTransfer: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "Planned large payments (treasury moves, payroll) fire too; the threshold (`largeTransferPercent`, default 10 % of the sending account's balance in that asset, and optional per-asset absolute amounts) can be tuned. Several transfers of the same asset from the same account are added up, so splitting a payment does not hide it. When the balance could not be read and no absolute threshold is set, the transfer cannot be judged and the analysis is marked incomplete instead.",
    what: "SOL or token transfers that together move at least `largeTransferPercent` of the sending account's balance in that asset, or at least the absolute amount configured for that asset.",
    why: "Draining a vault is the most common goal of a malicious proposal. Seeing the share of the balance at stake helps catch a proposal that moves far more than expected.",
  },
  evaluate(context) {
    const groups = new Map<string, { readonly first: Transfer; readonly group: Transfer[] }>();
    for (const transfer of transfers(context)) {
      const key = `${transfer.at.proposed}|${transfer.from}|${transfer.asset}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { first: transfer, group: [transfer] });
      } else {
        existing.group.push(transfer);
      }
    }
    const findings: Finding[] = [];
    const { largeTransferBasisPoints: threshold, largeTransferAbsolute } = context.options;
    for (const { first, group } of groups.values()) {
      const total = group.reduce((sum, t) => sum + t.amount, 0n);
      const balance = context.facts.balances?.find(
        (b) => b.owner === first.from && b.asset === first.asset,
      )?.amount;
      const absolute = largeTransferAbsolute.get(first.asset);
      const byShare = balance !== undefined && total * 10_000n >= balance * threshold;
      const byAmount = absolute !== undefined && total >= absolute;
      if (!byShare && !byAmount) {
        continue;
      }
      const share =
        balance === undefined ? "unknown" : balance === 0n ? "100+" : percentText(total, balance);
      findings.push(
        finding(this, {
          at: first.at,
          evidence: [
            ev("from", first.from),
            ev("asset", first.asset),
            ev("totalBaseUnits", total),
            ev("balanceBaseUnits", balance ?? "unknown"),
            ev("shareOfBalancePercent", share),
            ev("thresholdPercent", basisPointsText(threshold)),
            ev("absoluteThresholdBaseUnits", absolute ?? "none"),
            ...group.map((t) => ev("transfer", `${t.at.path}: ${t.amount} to ${t.to}`)),
          ],
          params: {
            ...first.assetParams,
            amount: String(total),
            from: first.from,
            share,
            threshold: basisPointsText(threshold),
          },
          provenance: "rule-inference",
          variant: byShare ? "share" : "absolute",
        }),
      );
    }
    return findings;
  },
  id: "VGL-W004",
  name: "Large transfer",
  titleKey: "finding.VGL-W004",
  variants: ["share", "absolute"],
};

export const newDestination: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "Paying someone for the first time fires. Only runs when `historyDepth` is above 0; this multisig's vaults and your known addresses are never reported.",
    what: "A transfer to an address that received nothing in the vault's last `historyDepth` transactions.",
    why: "Attackers substitute their own address for a familiar one. A destination the vault has never paid before deserves a careful check of the full address.",
  },
  evaluate(context) {
    const recent = context.facts.recentDestinations;
    if (context.options.historyDepth === 0 || recent === undefined) {
      return [];
    }
    const seen = new Set<string>();
    const findings: Finding[] = [];
    for (const transfer of transfers(context)) {
      const key = `${transfer.at.proposed}|${transfer.to}`;
      if (recent.has(transfer.to) || isOwnAddress(context, transfer.to) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      findings.push(
        finding(this, {
          at: transfer.at,
          evidence: [
            ev("destination", transfer.to),
            ev("historyDepth", context.options.historyDepth),
            ev("recentDestinationsChecked", recent.size),
          ],
          params: { destination: transfer.to, historyDepth: String(context.options.historyDepth) },
          provenance: "rule-inference",
        }),
      );
    }
    return findings;
  },
  id: "VGL-W005",
  name: "New destination",
  titleKey: "finding.VGL-W005",
  variants: [""],
};

/** The simulation results to check: the single one, or every batch item's. */
function simulationResults(context: RuleContext): readonly SimulationResult[] {
  const simulation = context.simulation;
  if (simulation === undefined) {
    return [];
  }
  return simulation.status === "batch" ? simulation.items : [simulation];
}

export const simulationProblem: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "A proposal whose time lock has not passed, or that depends on state that will only exist later, can fail to simulate today and still execute correctly. If you turned simulation off this rule does not fire; the analysis is marked incomplete instead.",
    what: "Simulation was attempted and either failed or could not be run.",
    why: "Simulation is the only independent view of the balances a transaction will actually change. Without it the balance checks (VGL-W007) cannot run.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const simulation of simulationResults(context)) {
      if (simulation.status === "success") {
        continue;
      }
      const detail = sanitizeOnchainString(
        simulation.status === "failed" ? simulation.error : simulation.reason,
      ).text;
      const item =
        simulation.batchItem === undefined ? {} : { batchItem: String(simulation.batchItem) };
      findings.push(
        finding(this, {
          evidence: [
            ev("status", simulation.status),
            ev("detail", detail),
            ...(simulation.batchItem === undefined ? [] : [ev("batchItem", simulation.batchItem)]),
          ],
          params: { detail, ...item },
          provenance: "simulation",
          variant: simulation.status,
        }),
      );
    }
    return findings;
  },
  id: "VGL-W006",
  name: "Simulation failed or unavailable",
  titleKey: "finding.VGL-W006",
  variants: ["failed", "unavailable"],
};

export const unexpectedBalanceChanges: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "Programs that move funds through accounts they do not list as writable in the decoded instruction (for example through a CPI into an opaque program) fire. The fee payer's own SOL decrease (the transaction fee) is not reported.",
    what: "The simulation changes the balance of an account that no decoded instruction lists as writable.",
    why: "A balance change nothing in the decoded transaction explains means something is happening that the summary does not show.",
  },
  evaluate(context) {
    const results = simulationResults(context).filter(
      (simulation) => simulation.status === "success",
    );
    if (results.length === 0) {
      return [];
    }
    const explained = new Set<Address>();
    for (const { instruction } of walkInstructions(context.instructions)) {
      if (instruction.decoder === "none") {
        continue;
      }
      for (const account of instruction.accounts) {
        if (account.isWritable) {
          explained.add(account.address);
        }
      }
    }
    const findings: Finding[] = [];
    for (const simulation of results) {
      const unexplained = simulation.balanceChanges.filter(
        (change) =>
          change.pre !== change.post &&
          !explained.has(change.account) &&
          !(
            change.account === context.feePayer &&
            change.asset === "SOL" &&
            change.post < change.pre
          ),
      );
      if (unexplained.length === 0) {
        continue;
      }
      findings.push(
        finding(this, {
          evidence: [
            ...unexplained.map((change) =>
              ev(
                "change",
                `${change.account} ${change.asset} ${change.pre} -> ${change.post} (${change.post - change.pre})`,
              ),
            ),
            ...(simulation.batchItem === undefined ? [] : [ev("batchItem", simulation.batchItem)]),
          ],
          params: {
            count: String(unexplained.length),
            ...(simulation.batchItem === undefined
              ? {}
              : { batchItem: String(simulation.batchItem) }),
          },
          provenance: "simulation",
        }),
      );
    }
    return findings;
  },
  id: "VGL-W007",
  name: "Unexpected balance changes",
  titleKey: "finding.VGL-W007",
  variants: [""],
};

/** Sanitizer flags that make a declared token name or symbol suspicious. */
const SUSPICIOUS_FLAGS: ReadonlySet<SanitizeFlag> = new Set<SanitizeFlag>([
  "bidi-removed",
  "control-chars-removed",
  "invisible-removed",
  "mixed-scripts",
  "non-ascii",
  "zero-width-removed",
]);

export const impersonatingToken: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "Wrapped or bridged versions of a registry token (for example another issuer's USDC) fire, because their declared name matches but the mint is not the registry one. Tokens with non-Latin names fire the suspicious-characters variant. Only registry tokens of the same cluster are compared.",
    what: "A token whose declared symbol or name looks like a registry token's (after Unicode normalization, mapping look-alike characters and ignoring case and punctuation) but whose mint differs; or whose declared name or symbol contains invisible, control, bidirectional or non-ASCII characters, or mixes scripts.",
    why: "Anyone can create a token called “USDC”. Fake tokens that look like real ones are used to disguise what a transfer really moves.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    const registry = REGISTRY_TOKENS.filter((token) => token.cluster === context.cluster);
    for (const token of context.tokens) {
      const declared = token.declared;
      if (token.registry !== undefined || declared === undefined) {
        continue;
      }
      const lookalike = registry.find(
        (entry) =>
          looksAlike(declared.symbol.text, entry.symbol) ||
          looksAlike(declared.name.text, entry.name),
      );
      const flags = [...new Set([...declared.symbol.flags, ...declared.name.flags])].filter(
        (flag) => SUSPICIOUS_FLAGS.has(flag),
      );
      if (lookalike === undefined && flags.length === 0) {
        continue;
      }
      findings.push(
        finding(this, {
          evidence: [
            ev("mint", token.mint),
            ev("declaredSymbol", declared.symbol.text),
            ev("declaredName", declared.name.text),
            ev("declaredBy", declared.source),
            ...(lookalike === undefined
              ? []
              : [ev("looksLike", `${lookalike.symbol} (mint ${lookalike.address})`)]),
            ...(flags.length === 0 ? [] : [ev("flags", flags.join(","))]),
          ],
          params: {
            declaredName: declared.name.text,
            declaredSymbol: declared.symbol.text,
            mint: token.mint,
            ...(lookalike === undefined
              ? {}
              : { registryMint: lookalike.address, registrySymbol: lookalike.symbol }),
          },
          provenance: "onchain",
          variant: lookalike === undefined ? "characters" : "impersonation",
        }),
      );
    }
    return findings;
  },
  id: "VGL-W008",
  name: "Impersonating token",
  titleKey: "finding.VGL-W008",
  variants: ["impersonation", "characters"],
};

export const durableNonce: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives: "Offline and hardware-wallet signing flows use durable nonces legitimately.",
    what: "In base64 mode: the transaction starts with a System `AdvanceNonceAccount`, so it uses a durable nonce instead of a recent blockhash (the runtime only treats instruction 0 this way).",
    why: "A durable-nonce transaction never expires: once signed, it can be submitted at any later time by whoever holds it, long after the signer has forgotten about it.",
  },
  evaluate(context) {
    const first = context.instructions[0];
    if (
      context.input.kind !== "raw-transaction" ||
      first === undefined ||
      !isInstruction(first, PROGRAMS.system, "advanceNonceAccount")
    ) {
      return [];
    }
    const nonceAccount = roleText(first, "nonceAccount");
    const nonceAuthority = roleText(first, "nonceAuthority");
    return [
      finding(this, {
        evidence: [ev("nonceAccount", nonceAccount), ev("nonceAuthority", nonceAuthority)],
        instructionIndex: 0,
        params: { nonceAccount, nonceAuthority },
        provenance: first.provenance,
      }),
    ];
  },
  id: "VGL-W009",
  name: "Durable nonce",
  titleKey: "finding.VGL-W009",
  variants: [""],
};

export const fragileMultisig: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "Some teams deliberately run a 1-of-N multisig, or keep a config authority for recovery. The warning describes the multisig itself, not this proposal.",
    what: "The multisig's threshold is 1 (any single member can approve alone), or it has a config authority that can change its settings without a vote.",
    why: "One compromised key is then enough to take control: through a single approval, or through the config authority.",
  },
  evaluate(context) {
    const multisig = context.multisig;
    if (multisig === undefined) {
      return [];
    }
    const findings: Finding[] = [];
    if (multisig.threshold <= 1) {
      findings.push(
        finding(this, {
          evidence: [ev("threshold", multisig.threshold), ev("members", multisig.members.length)],
          params: { members: String(multisig.members.length), multisig: multisig.address },
          provenance: "onchain",
          variant: "threshold",
        }),
      );
    }
    if (multisig.isControlled) {
      findings.push(
        finding(this, {
          evidence: [
            ev("configAuthority", multisig.configAuthority),
            ev("configAuthorityIs", describeAddress(context, multisig.configAuthority)),
          ],
          params: { configAuthority: multisig.configAuthority, multisig: multisig.address },
          provenance: "onchain",
          variant: "controlled",
        }),
      );
    }
    return findings;
  },
  id: "VGL-W010",
  name: "Fragile multisig",
  titleKey: "finding.VGL-W010",
  variants: ["threshold", "controlled"],
};

export const incompleteAnalysis: Rule = {
  defaultSeverity: "warning",
  docs: {
    falsePositives:
      "None: any gap means part of the transaction could not be checked. It is always shown first so an empty findings list is never mistaken for a clean result.",
    what: "The analysis has at least one gap: something could not be read, decoded, simulated or verified.",
    why: "The absence of findings means nothing about the parts that could not be analysed.",
  },
  evaluate(context) {
    if (context.gaps.length === 0) {
      return [];
    }
    return [
      finding(this, {
        evidence: context.gaps.map((gap) => ev(gap.code, gap.message)),
        params: { count: String(context.gaps.length) },
        provenance: "rule-inference",
      }),
    ];
  },
  id: "VGL-W011",
  name: "Incomplete analysis",
  titleKey: "finding.VGL-W011",
  variants: [""],
};
