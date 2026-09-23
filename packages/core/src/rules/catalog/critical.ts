import { type Address, isAddress } from "@solana/kit";
import type { AnalysisGapCode, DecodedInstruction, Finding } from "../../report.js";
import {
  accountAt,
  accountByRole,
  addressArg,
  argOf,
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
import type { Rule, RuleContext } from "../types.js";
import { walkInstructions } from "../walk.js";

const UNKNOWN = "unknown";

/** Token amount params copied from the enriched summary, so the finding can show the amount. */
function tokenParams(instruction: DecodedInstruction): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of ["mint", "decimals", "symbol", "declaredName", "declaredSymbol"]) {
    const value = instruction.summary?.params[name];
    if (value !== undefined) {
      params[name] = value;
    }
  }
  return params;
}

export const programUpgrade: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "Every legitimate upgrade fires this rule too: it is critical because an upgrade replaces all of a program's behaviour, not because upgrades are suspicious. Compare the buffer's executable hash with the verified build you expect.",
    what: "A BPF Upgradeable Loader `Upgrade` instruction: the program's code is replaced with the contents of a buffer account.",
    why: "After the upgrade the program can do anything its new code allows, including moving every asset it controls. What matters is exactly which code is in the buffer, so the finding shows the buffer, its executable hash and the program's current verification status.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      if (!isInstruction(ix, PROGRAMS.loader, "upgrade")) {
        continue;
      }
      const program = roleText(ix, "programAccount");
      const buffer = roleText(ix, "bufferAccount");
      const bufferInfo = context.facts.buffers?.get(buffer as Address);
      const info = context.programs.find((p) => p.address === program);
      const bufferHash = bufferInfo?.executableHash ?? UNKNOWN;
      const verification = info?.verification ?? UNKNOWN;
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("program", program),
            ev("programData", roleText(ix, "programDataAccount")),
            ev("buffer", buffer),
            ev("bufferExecutableHash", bufferHash),
            ev("currentVerification", verification),
            ev("upgradeAuthority", roleText(ix, "authority")),
            ev("spill", roleText(ix, "spillAccount")),
          ],
          params: { buffer, bufferHash, program, verification },
          provenance: ix.provenance,
        }),
      );
    }
    return findings;
  },
  id: "VGL-C001",
  name: "Program upgrade",
  titleKey: "finding.VGL-C001",
  variants: [""],
};

export const upgradeAuthorityChange: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "Handing the upgrade authority to this multisig's own vault (for example when moving a program under multisig control) still fires, with the milder wording. Making a program immutable on purpose also fires: it is irreversible, so it is always worth a second look.",
    what: "A BPF Upgradeable Loader `SetAuthority` or `SetAuthorityChecked` on a program's ProgramData account or on a buffer.",
    why: "Whoever holds a program's upgrade authority can replace its code at any time. Giving it to an address outside this multisig hands over full control of the program; removing it makes the program immutable forever.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      if (!isInstruction(ix, PROGRAMS.loader, "setAuthority", "setAuthorityChecked")) {
        continue;
      }
      const account = roleText(ix, "bufferOrProgramDataAccount");
      const current = roleText(ix, "currentAuthority");
      const next = accountByRole(ix, "newAuthority");
      const isBuffer = context.facts.buffers?.has(account as Address) === true;
      const program = context.programs.find((p) => p.programData === account)?.address;
      const target = isBuffer ? "buffer" : program === undefined ? UNKNOWN : "programData";
      const variant =
        next === undefined ? "immutable" : isOwnAddress(context, next) ? "ownVault" : "external";
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("account", account),
            ev("accountKind", target),
            ev("program", program ?? UNKNOWN),
            ev("oldAuthority", current),
            ev("newAuthority", next ?? "none"),
            ev("newAuthorityIs", next === undefined ? "none" : describeAddress(context, next)),
          ],
          params: {
            account,
            newAuthority: next ?? "none",
            oldAuthority: current,
            ...(program === undefined ? {} : { program }),
          },
          provenance: ix.provenance,
          variant,
        }),
      );
    }
    return findings;
  },
  id: "VGL-C002",
  name: "Upgrade authority change",
  titleKey: "finding.VGL-C002",
  variants: ["immutable", "ownVault", "external"],
};

const TOKEN_METADATA_AUTHORITY_UPDATES: Readonly<Record<string, string>> = {
  updateTokenGroupUpdateAuthority: "group",
  updateTokenMetadataUpdateAuthority: "metadata",
};

export const tokenAuthorityChange: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "Routine hand-overs (for example moving a mint authority to a new multisig) fire too. Removing an authority for good (for example fixing a token's supply) also fires, because it is irreversible.",
    what: "Any SPL Token or Token-2022 `SetAuthority` (mint, freeze, account owner, close and every extension authority), and the Token-2022 metadata and group update-authority changes.",
    why: "Token authorities decide who can mint new tokens, freeze accounts, move or close accounts, or change a token's fees, hooks and metadata. Handing one over gives that power to someone else without another vote.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      if (!isTokenProgram(ix.programId) || ix.decoder === "none") {
        continue;
      }
      const metadataRole =
        ix.name === undefined ? undefined : TOKEN_METADATA_AUTHORITY_UPDATES[ix.name];
      let account: string;
      let authorityType: string;
      let current: string;
      let next: string;
      if (ix.name === "setAuthority") {
        account = roleText(ix, "owned");
        authorityType = String(argOf(ix, "authorityType"));
        current = roleText(ix, "owner");
        next = addressArg(ix, "newAuthority") ?? "none";
      } else if (metadataRole !== undefined) {
        account = roleText(ix, metadataRole);
        authorityType = metadataRole === "group" ? "GroupUpdate" : "MetadataUpdate";
        current = roleText(ix, "updateAuthority");
        next = addressArg(ix, "newUpdateAuthority") ?? "none";
      } else {
        continue;
      }
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("account", account),
            ev("authorityType", authorityType),
            ev("oldAuthority", current),
            ev("newAuthority", next),
            ev(
              "newAuthorityIs",
              next === "none" ? "none" : describeAddress(context, next as Address),
            ),
          ],
          params: { account, authorityType, newAuthority: next, oldAuthority: current },
          provenance: ix.provenance,
          variant: next === "none" ? "removed" : "",
        }),
      );
    }
    return findings;
  },
  id: "VGL-C003",
  name: "Token authority change",
  titleKey: "finding.VGL-C003",
  variants: ["", "removed"],
};

export const delegateApproval: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "Some protocols legitimately ask for a delegate (for example an escrow or a lending position). The finding shows the delegate and the amount so it can be checked against what was intended.",
    what: "An SPL Token or Token-2022 `Approve` or `ApproveChecked`.",
    why: "A delegate can move up to the approved amount out of the token account at any time, without another vote of the multisig.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      if (
        !isInstruction(ix, PROGRAMS.token, "approve", "approveChecked") &&
        !isInstruction(ix, PROGRAMS.token2022, "approve", "approveChecked")
      ) {
        continue;
      }
      const delegate = roleText(ix, "delegate");
      const source = roleText(ix, "source");
      const amount = bigintArg(ix, "amount");
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("source", source),
            ev("owner", roleText(ix, "owner")),
            ev("delegate", delegate),
            ev("delegateIs", describeAddress(context, delegate as Address)),
            ev("amountBaseUnits", amount ?? UNKNOWN),
            ev("mint", ix.summary?.params.mint ?? UNKNOWN),
          ],
          params: {
            ...tokenParams(ix),
            amount: amount === undefined ? UNKNOWN : String(amount),
            delegate,
            source,
          },
          provenance: ix.provenance,
        }),
      );
    }
    return findings;
  },
  id: "VGL-C004",
  name: "Delegate approval",
  titleKey: "finding.VGL-C004",
  variants: [""],
};

export const accountOwnerChange: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "Creating a new account for a program (`CreateAccount`) does not fire. `Assign` on a freshly allocated account is part of some legitimate set-up flows; check that the account is new and holds nothing.",
    what: "A System Program `Assign` or `AssignWithSeed`.",
    why: "The owner program has full control over an account's data and lamports. Assigning a vault or any funded account to another program hands its contents to that program.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      if (!isInstruction(ix, PROGRAMS.system, "assign", "assignWithSeed")) {
        continue;
      }
      const account = roleText(ix, "account");
      const owner = addressArg(ix, "programAddress") ?? UNKNOWN;
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("account", account),
            ev("accountIs", describeAddress(context, account as Address)),
            ev("newOwnerProgram", owner),
          ],
          params: { account, owner },
          provenance: ix.provenance,
        }),
      );
    }
    return findings;
  },
  id: "VGL-C005",
  name: "Account owner change",
  titleKey: "finding.VGL-C005",
  variants: [""],
};

const STAKE_AUTHORIZE_NEW: Readonly<Record<string, (ix: DecodedInstruction) => Address | null>> = {
  authorize: (ix) => addressArg(ix, "arg0"),
  authorizeChecked: (ix) => accountByRole(ix, "newAuthority") ?? null,
  authorizeCheckedWithSeed: (ix) => accountByRole(ix, "newAuthority") ?? null,
  authorizeWithSeed: (ix) => addressArg(ix, "newAuthorizedPubkey"),
};

export const stakeAuthorityChange: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "Moving stake accounts to a new custody set-up fires too. `SetLockup` that only changes the lockup dates (no new custodian) does not fire.",
    what: "A Stake Program `Authorize`, `AuthorizeChecked`, `AuthorizeWithSeed`, `AuthorizeCheckedWithSeed`, or a `SetLockup` / `SetLockupChecked` that sets a new lockup custodian. Vote-account authority changes cannot be detected: the Vote program is not decoded (they show as an opaque instruction, VGL-W001).",
    why: "The withdraw authority can take all the stake; the staker can redirect it; the custodian can lift a lockup. Changing any of them hands that power to the new address.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      if (ix.programId !== PROGRAMS.stake || ix.decoder === "none" || ix.name === undefined) {
        continue;
      }
      const stake = roleText(ix, "stake");
      const newAuthority = STAKE_AUTHORIZE_NEW[ix.name];
      let variant: string;
      let next: string;
      let kind: string;
      if (newAuthority !== undefined) {
        variant = "authorize";
        next = newAuthority(ix) ?? UNKNOWN;
        kind = String(argOf(ix, ix.name === "authorize" ? "arg1" : "stakeAuthorize"));
      } else {
        const custodian =
          ix.name === "setLockup"
            ? addressArg(ix, "custodian")
            : ix.name === "setLockupChecked"
              ? (accountAt(ix, 2) ?? null)
              : null;
        if (custodian === null) {
          continue;
        }
        variant = "custodian";
        next = custodian;
        kind = "custodian";
      }
      const old = accountByRole(ix, "authority") ?? roleText(ix, "base");
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("stakeAccount", stake),
            ev("authority", kind),
            ev("oldAuthority", old),
            ev("newAuthority", next),
            ev("newAuthorityIs", describeAddress(context, next as Address)),
          ],
          params: { newAuthority: next, oldAuthority: old, stake, stakeAuthorize: kind },
          provenance: ix.provenance,
          variant,
        }),
      );
    }
    return findings;
  },
  id: "VGL-C007",
  name: "Stake authority change",
  titleKey: "finding.VGL-C007",
  variants: ["authorize", "custodian"],
};

/** Every address the transaction mentions: accounts, address arguments, token account owners. */
function mentionedAddresses(context: RuleContext): Set<Address> {
  const out = new Set<Address>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      if (isAddress(value)) {
        out.add(value);
      }
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(collect);
    }
  };
  for (const { instruction } of walkInstructions(context.instructions)) {
    out.add(instruction.programId);
    for (const account of instruction.accounts) {
      out.add(account.address);
    }
    collect(instruction.args);
    collect(instruction.summary?.params.destinationOwner);
  }
  for (const action of context.configActions ?? []) {
    collect(action);
  }
  return out;
}

/**
 * An address ending in twelve or more `1`s was constructed, not generated: matching twelve fixed
 * base58 characters would take about 58¹² (~10²¹) key or PDA attempts. Native program and sysvar
 * ids look like this (`StakeConfig111…` shares `Stak…1111` with `Stake111…`), so they are never
 * reported as look-alikes; an attacker's look-alike can only match the eight visible characters.
 */
const CONSTRUCTED_ADDRESS = /1{12}$/;

/** Same first and last four characters (what a wallet usually shows) but a different address. */
export function looksLike(a: string, b: string): boolean {
  return a !== b && a.slice(0, 4) === b.slice(0, 4) && a.slice(-4) === b.slice(-4);
}

export const addressPoisoning: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "Two unrelated addresses sharing the same first and last four characters by chance is very unlikely (about one in 58⁸), so a match is almost always deliberate. Add the address to your known addresses if it really is yours. Addresses ending in twelve or more `1`s (native program and sysvar ids, which are constructed rather than generated and cannot be ground by an attacker) are never reported.",
    what: "An address in the transaction that is not known, but shares its first four and last four characters with a known address: a member, a vault, the multisig, a registry program or token, one of your known addresses, or a recent destination.",
    why: "Address poisoning: attackers generate look-alike addresses so that a signer who only checks the start and end of an address approves sending funds, or authority, to the attacker.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    const known = [...context.known.keys()];
    for (const address of mentionedAddresses(context)) {
      if (context.known.has(address) || CONSTRUCTED_ADDRESS.test(address)) {
        continue;
      }
      const lookalikes = known.filter((k) => looksLike(address, k));
      const [first] = lookalikes;
      if (first === undefined) {
        continue;
      }
      findings.push(
        finding(this, {
          evidence: [
            ev("address", address),
            ...lookalikes.map((k) => ev("resembles", `${k} (${describeAddress(context, k)})`)),
          ],
          params: { address, resembles: first },
          provenance: "rule-inference",
        }),
      );
    }
    return findings;
  },
  id: "VGL-C008",
  name: "Possible address poisoning",
  titleKey: "finding.VGL-C008",
  variants: [""],
};

/** Signers of the analysed transaction (and of any proposal message it carries). */
function signers(context: RuleContext): Set<Address> {
  const out = new Set<Address>();
  if (context.feePayer !== undefined) {
    out.add(context.feePayer);
  }
  for (const { instruction } of walkInstructions(context.instructions)) {
    for (const account of instruction.accounts) {
      if (account.isSigner) {
        out.add(account.address);
      }
    }
  }
  return out;
}

export const closeToExternal: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "Closing an empty token account and sending its rent to a member's own wallet fires too (a member is not a vault). In base64 mode, with no multisig to compare with, any recipient that is not a signer of the transaction or one of your known addresses counts as external.",
    what: "An SPL Token / Token-2022 `CloseAccount`, or a BPF Upgradeable Loader `Close`, whose lamports go to an address that is not a vault of this multisig (or one of your known addresses).",
    why: "Closing sends everything the account holds in lamports to the recipient; closing a program's ProgramData account also deletes the program for good.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    const rawSigners = context.input.kind === "raw-transaction" ? signers(context) : new Set();
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      let account: Address | undefined;
      let destination: Address | undefined;
      let variant: string;
      if (
        isInstruction(ix, PROGRAMS.token, "closeAccount") ||
        isInstruction(ix, PROGRAMS.token2022, "closeAccount")
      ) {
        account = accountByRole(ix, "account");
        destination = accountByRole(ix, "destination");
        variant = "token";
      } else if (isInstruction(ix, PROGRAMS.loader, "close")) {
        account = accountByRole(ix, "bufferOrProgramDataAccount");
        destination = accountByRole(ix, "destinationAccount");
        variant = "loader";
      } else {
        continue;
      }
      if (
        destination === undefined ||
        isOwnAddress(context, destination) ||
        rawSigners.has(destination)
      ) {
        continue;
      }
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("closedAccount", account ?? UNKNOWN),
            ev("lamportsTo", destination),
            ev("recipientIs", describeAddress(context, destination)),
          ],
          params: { account: account ?? UNKNOWN, destination },
          provenance: ix.provenance,
          variant,
        }),
      );
    }
    return findings;
  },
  id: "VGL-C009",
  name: "Account closed to an external destination",
  titleKey: "finding.VGL-C009",
  variants: ["token", "loader"],
};

/** Gaps meaning the transaction's accounts or its Squads structure could not be resolved. */
const UNRESOLVABLE_GAPS: ReadonlySet<AnalysisGapCode> = new Set<AnalysisGapCode>([
  "ACCOUNT_INDEX_OUT_OF_RANGE",
  "ACCOUNT_UNRESOLVED",
  "EMBEDDED_MESSAGE_INVALID",
  "LOOKUP_TABLE_INDEX_OUT_OF_RANGE",
  "LOOKUP_TABLE_INVALID",
  "LOOKUP_TABLE_NOT_FOUND",
]);

export const unresolvableMessage: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "A lookup table that was closed after the proposal was created makes an old proposal unresolvable too; it then also cannot be executed as it stands.",
    what: "The transaction cannot be fully resolved: a lookup table is missing or invalid, an account index points outside the transaction, a transaction carried inside a Squads instruction cannot be decoded, or a Squads instruction itself is malformed.",
    why: "If the accounts an instruction touches cannot be established, nobody can say what it will do. A proposal built so that it cannot be displayed is a known way to hide its effect.",
  },
  evaluate(context) {
    const byCode = new Map<AnalysisGapCode, { messages: string[]; indices: Set<number> }>();
    for (const gap of context.gaps) {
      const squadsMalformed =
        gap.code === "MALFORMED_INSTRUCTION" && gap.address === PROGRAMS.squads;
      if (!UNRESOLVABLE_GAPS.has(gap.code) && !squadsMalformed) {
        continue;
      }
      const entry = byCode.get(gap.code) ?? { indices: new Set<number>(), messages: [] };
      entry.messages.push(gap.message);
      if (gap.instructionIndex !== undefined) {
        entry.indices.add(gap.instructionIndex);
      }
      byCode.set(gap.code, entry);
    }
    return [...byCode].map(([code, { messages, indices }]) => {
      const [first, ...others] = [...indices];
      return finding(this, {
        evidence: [ev("gap", code), ...messages.map((m) => ev("detail", m))],
        params: { code },
        provenance: "rule-inference",
        ...(first !== undefined && others.length === 0 ? { instructionIndex: first } : {}),
      });
    });
  },
  id: "VGL-C010",
  name: "Unresolvable message",
  titleKey: "finding.VGL-C010",
  variants: [""],
};

export const bufferExternalAuthority: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "None expected: for the upgrade to succeed the buffer authority must equal the program's upgrade authority, so a buffer controlled by someone else is either a mistake or an opportunity to swap its contents before execution.",
    what: "A loader `Upgrade` whose buffer's authority (read from chain) is not the upgrade authority signing the upgrade (this multisig's vault).",
    why: "Whoever controls the buffer can rewrite its contents after the vote and hand the buffer to the vault just before execution: members would approve one program and deploy another.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    for (const at of walkInstructions(context.instructions)) {
      const ix = at.instruction;
      if (!isInstruction(ix, PROGRAMS.loader, "upgrade")) {
        continue;
      }
      const buffer = accountByRole(ix, "bufferAccount");
      const info = buffer === undefined ? undefined : context.facts.buffers?.get(buffer);
      const upgradeAuthority = accountByRole(ix, "authority");
      if (info === undefined || info.authority === null || info.authority === upgradeAuthority) {
        continue;
      }
      findings.push(
        finding(this, {
          at,
          evidence: [
            ev("buffer", info.address),
            ev("bufferAuthority", info.authority),
            ev("bufferAuthorityIs", describeAddress(context, info.authority)),
            ev("upgradeAuthority", upgradeAuthority ?? UNKNOWN),
          ],
          params: { buffer: info.address, bufferAuthority: info.authority },
          provenance: "onchain",
        }),
      );
    }
    return findings;
  },
  id: "VGL-C011",
  name: "Upgrade buffer with external authority",
  titleKey: "finding.VGL-C011",
  variants: [""],
};

export const rpcDisagreement: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "One of the two RPC endpoints may simply be behind (it has not seen the latest vote or change yet). Vigil re-reads both at the same slot once before reporting, so a lasting disagreement means at least one endpoint is out of date, misconfigured or lying. Only runs when you configure a second RPC.",
    what: "A critical account (the multisig, the proposal's transaction or proposal account, a batch item, a lookup table, a program's ProgramData, an upgrade buffer) has different content on your two RPC endpoints.",
    why: "Everything Vigil shows comes from what the RPC says. If two independent endpoints disagree on the accounts that decide what the proposal does, you cannot know which one describes what will really execute.",
  },
  evaluate(context) {
    return (context.facts.rpcMismatches ?? []).map((mismatch) =>
      finding(this, {
        evidence: [
          ev("account", mismatch.address),
          ev("accountKind", mismatch.kind),
          ev("primarySha256", mismatch.primarySha256 ?? "missing"),
          ev("secondarySha256", mismatch.secondarySha256 ?? "missing"),
        ],
        params: { account: mismatch.address, kind: mismatch.kind },
        provenance: "rule-inference",
      }),
    );
  },
  id: "VGL-C012",
  name: "RPCs disagree",
  titleKey: "finding.VGL-C012",
  variants: [""],
};
