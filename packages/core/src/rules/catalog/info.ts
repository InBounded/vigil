import type { Address } from "@solana/kit";
import type { Finding } from "../../report.js";
import { argOf, bigintArg, ev, finding, MEMO_PROGRAMS, PROGRAMS } from "../helpers.js";
import type { Rule } from "../types.js";
import { walkInstructions } from "../walk.js";

/** `MAX_COMPUTE_UNIT_LIMIT` (agave `program-runtime/src/execution_budget.rs`). */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000n;
/** `MICRO_LAMPORTS_PER_LAMPORT` (agave `compute-budget/src/compute_budget_limits.rs`). */
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/**
 * Agave's `get_prioritization_fee`: `ceil(price × limit / 1,000,000)` lamports, with the requested
 * limit capped at `MAX_COMPUTE_UNIT_LIMIT` (`compute_budget_instruction_details.rs`).
 */
export function priorityFeeLamports(microLamportsPerUnit: bigint, unitLimit: bigint): bigint {
  const limit = unitLimit < MAX_COMPUTE_UNIT_LIMIT ? unitLimit : MAX_COMPUTE_UNIT_LIMIT;
  return (
    (microLamportsPerUnit * limit + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT
  );
}

export const computeBudget: Rule = {
  defaultSeverity: "info",
  docs: {
    falsePositives: "Informational.",
    what: "The compute budget the transaction requests: compute-unit limit and price, and the maximum priority fee that results (Compute Budget instructions, or a v1 transaction's inline settings). Compute Budget instructions inside a Squads proposal are also listed, with a note that they have no effect there.",
    why: "The priority fee is paid by the fee payer on top of the base fee. Inside a proposal, Compute Budget instructions do nothing (the program is a no-op when invoked; the runtime only reads them at the top level of a transaction).",
  },
  evaluate(context) {
    let limit: bigint | undefined;
    let price: bigint | undefined;
    const inProposal: string[] = [];
    let found = false;
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      if (ix.programId !== PROGRAMS.computeBudget || ix.decoder === "none") {
        continue;
      }
      if (at.depth > 0 || context.input.kind === "squads-proposal") {
        inProposal.push(at.path);
        continue;
      }
      found = true;
      const units = argOf(ix, "units");
      if (ix.name === "setComputeUnitLimit" && typeof units === "number") {
        limit = BigInt(units);
      } else if (ix.name === "setComputeUnitPrice") {
        price = bigintArg(ix, "microLamports");
      }
    }

    const findings: Finding[] = [];
    const config = context.transactionConfig;
    if (config !== undefined) {
      const fee = config.priorityFeeLamports ?? 0n;
      findings.push(
        finding(this, {
          evidence: [
            ev("priorityFeeLamports", fee),
            ev("computeUnitLimit", config.computeUnitLimit ?? "default"),
          ],
          params: { fee: String(fee) },
          provenance: "onchain",
          variant: "v1",
        }),
      );
    }
    if (found) {
      const evidence = [
        ev("computeUnitLimit", limit ?? "default"),
        ev("microLamportsPerUnit", price ?? 0n),
      ];
      if (price === undefined || price === 0n) {
        findings.push(
          finding(this, {
            evidence,
            instructionIndex: 0,
            params: {},
            provenance: "onchain",
            variant: "noPriorityFee",
          }),
        );
      } else if (limit === undefined) {
        findings.push(
          finding(this, {
            evidence,
            instructionIndex: 0,
            params: { price: String(price) },
            provenance: "onchain",
            variant: "defaultLimit",
          }),
        );
      } else {
        const fee = priorityFeeLamports(price, limit);
        findings.push(
          finding(this, {
            evidence: [...evidence, ev("maxPriorityFeeLamports", fee)],
            instructionIndex: 0,
            params: { fee: String(fee), limit: String(limit), price: String(price) },
            provenance: "onchain",
            variant: "fee",
          }),
        );
      }
    }
    if (inProposal.length > 0) {
      findings.push(
        finding(this, {
          evidence: inProposal.map((path) => ev("instruction", path)),
          params: {},
          provenance: "onchain",
          variant: "inProposal",
        }),
      );
    }
    return findings;
  },
  id: "VGL-I001",
  name: "Compute budget and priority fee",
  titleKey: "finding.VGL-I001",
  variants: ["v1", "noPriorityFee", "defaultLimit", "fee", "inProposal"],
};

export const memo: Rule = {
  defaultSeverity: "info",
  docs: {
    falsePositives: "Informational.",
    what: "A Memo program instruction, with its text (sanitized: control, bidirectional and invisible characters removed).",
    why: "Memos are free text written by whoever built the transaction. They can describe the transaction honestly, or be written to mislead; they do not change what it does.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      const text = argOf(ix, "memo");
      if (!MEMO_PROGRAMS.includes(ix.programId) || typeof text !== "string") {
        continue;
      }
      const flags = (ix.sanitizer ?? []).flatMap((note) => note.flags);
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("memo", text),
            ...(flags.length === 0 ? [] : [ev("sanitizer", flags.join(","))]),
          ],
          params: { memo: text },
          provenance: ix.provenance,
        }),
      );
    }
    return findings;
  },
  id: "VGL-I002",
  name: "Memo",
  titleKey: "finding.VGL-I002",
  variants: [""],
};

export const lookupTables: Rule = {
  defaultSeverity: "info",
  docs: {
    falsePositives: "Informational.",
    what: "Address lookup tables the transaction (or the proposal) loads accounts from.",
    why: "Accounts loaded from a table are not written in the transaction itself. Existing table entries can never change (tables are append-only), so what was resolved now is what will be used, as long as the table is not closed.",
  },
  evaluate(context) {
    const tables = new Map<Address, number>();
    for (const { instruction } of walkInstructions(context.instructions)) {
      for (const account of instruction.accounts) {
        if (account.fromLookupTable !== undefined) {
          tables.set(account.fromLookupTable, (tables.get(account.fromLookupTable) ?? 0) + 1);
        }
      }
    }
    if (tables.size === 0) {
      return [];
    }
    return [
      finding(this, {
        evidence: [...tables].map(([table, uses]) =>
          ev("lookupTable", `${table} (${uses} account uses)`),
        ),
        params: { count: String(tables.size) },
        provenance: "onchain",
      }),
    ];
  },
  id: "VGL-I003",
  name: "Address lookup tables used",
  titleKey: "finding.VGL-I003",
  variants: [""],
};

export const proposalStatus: Rule = {
  defaultSeverity: "info",
  docs: {
    falsePositives: "Informational.",
    what: "The proposal's status: approvals against the threshold, rejections, cancellations, the time lock, and how long until it can be executed.",
    why: "Knowing how many approvals are still needed, and when the proposal becomes executable, tells members how much time is left to review it.",
  },
  evaluate(context) {
    const multisig = context.multisig;
    const proposal = context.proposal;
    if (multisig === undefined || proposal === undefined) {
      return [];
    }
    const timeLock = String(multisig.timeLockSeconds);
    if (proposal === null) {
      return [
        finding(this, {
          evidence: [ev("proposal", "none")],
          params: { threshold: String(multisig.threshold), timeLock },
          provenance: "onchain",
          variant: "missing",
        }),
      ];
    }
    const { approved, rejected, cancelled } = proposal.votes;
    const { kind, timestamp } = proposal.status;
    const params: Record<string, string> = {
      approvals: String(approved.length),
      cancellations: String(cancelled.length),
      rejections: String(rejected.length),
      remaining: String(Math.max(0, multisig.threshold - approved.length)),
      status: kind,
      threshold: String(multisig.threshold),
      timeLock,
    };
    let variant: string = kind;
    if (kind === "Approved" && timestamp !== null) {
      const left = timestamp + BigInt(multisig.timeLockSeconds) - context.now;
      params.secondsLeft = String(left > 0n ? left : 0n);
      variant = left > 0n ? "approvedWaiting" : "approvedReady";
    }
    return [
      finding(this, {
        evidence: [
          ev("status", kind),
          ev("statusTimestamp", timestamp ?? "none"),
          ev("now", context.now),
          ...approved.map((member) => ev("approvedBy", member)),
          ...rejected.map((member) => ev("rejectedBy", member)),
          ...cancelled.map((member) => ev("cancelledBy", member)),
        ],
        params,
        provenance: "onchain",
        variant,
      }),
    ];
  },
  id: "VGL-I004",
  name: "Proposal status",
  titleKey: "finding.VGL-I004",
  variants: [
    "missing",
    "Draft",
    "Active",
    "approvedWaiting",
    "approvedReady",
    "Approved",
    "Rejected",
    "Executing",
    "Executed",
    "Cancelled",
  ],
};

export const staleProposal: Rule = {
  defaultSeverity: "info",
  docs: {
    falsePositives:
      "None: the proposal cannot be executed. Note that a stale vault or batch proposal that was approved before becoming stale can still be executed, so it does not fire.",
    what: "The proposal can no longer be executed: it was rejected, cancelled or already executed; or it is stale (a settings change happened after it was created) and either is a config proposal, or was not approved before becoming stale.",
    why: "Voting on it has no effect. Staleness rules are those of the Squads v4 program: stale config transactions can never execute; stale vault and batch transactions can only if already approved.",
  },
  evaluate(context) {
    const multisig = context.multisig;
    const proposal = context.proposal;
    if (
      context.input.kind !== "squads-proposal" ||
      multisig === undefined ||
      proposal === undefined
    ) {
      return [];
    }
    const kind = proposal?.status.kind;
    const index = context.input.transactionIndex;
    const isStale = index <= multisig.staleTransactionIndex;
    let variant: string | undefined;
    if (kind === "Rejected" || kind === "Cancelled" || kind === "Executed") {
      variant = kind;
    } else if (isStale && context.transactionKind === "config") {
      variant = "staleConfig";
    } else if (isStale && kind !== "Approved" && kind !== "Executing") {
      variant = "staleNotApproved";
    }
    if (variant === undefined) {
      return [];
    }
    return [
      finding(this, {
        evidence: [
          ev("transactionIndex", index),
          ev("staleTransactionIndex", multisig.staleTransactionIndex),
          ev("transactionKind", context.transactionKind ?? "unknown"),
          ev("status", kind ?? "no proposal"),
        ],
        params: { transactionIndex: String(index) },
        provenance: "onchain",
        variant,
      }),
    ];
  },
  id: "VGL-I005",
  name: "Stale proposal",
  titleKey: "finding.VGL-I005",
  variants: ["Rejected", "Cancelled", "Executed", "staleConfig", "staleNotApproved"],
};
