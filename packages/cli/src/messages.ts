import { CATALOGS, t as coreText, type Locale } from "@vigil-sol/core";

/**
 * The CLI's own wording (headings, field names, progress). Sentences about what a transaction
 * does, findings, gaps, verdicts and simulation notes come from `@vigil-sol/core`'s catalogs, so
 * the CLI and the web app say the same thing.
 */
const en = {
  "alert.analysisFailed": "not analysed: {error}",
  "alert.approved": "Proposal #{index} approved: ready to execute",
  "alert.changed": "Proposal #{index}: {from} → {to}",
  "alert.closed": "Proposal #{index} closed (its final status could not be read)",
  "alert.does": "What it does:",
  "alert.field.multisig": "Multisig: {multisig} ({cluster})",
  "alert.field.verdict": "Verdict: {verdict}",
  "alert.findings": "Top findings ({shown} of {total}):",
  "alert.footer": "Read-only alert from Vigil · RPC {host} · slot {slot} · {time}",
  "alert.lastVerdict": "{verdict} (last analysis; not re-analysed)",
  "alert.link": "Details: {url}",
  "alert.more": "…and {count} more",
  "alert.new": "New proposal #{index} ({status})",
  "alert.newClosed": "New transaction #{index}, already closed before Vigil could read it",
  "alert.noFindings": "No findings from the checks performed.",
  "alert.notAnalysed": "not analysed",
  "alert.pending": "Pending proposal #{index} ({status})",
  "alert.status.closed": "closed",
  "alert.status.noProposal": "no proposal yet",
  "alert.timeLock": "Time lock {duration}: executable after {time}",
  "alert.truncated": "…(cut to fit the message limit; open the link or run vigil decode)",
  "balance.closed": "account closed",
  "balance.created": "account created",
  "balance.feeExcluded": "fee excluded",
  "balance.none": "The simulation reports no balance change.",
  "balance.tokenAccount": "token account {address}",
  "field.approvals": "Approvals",
  "field.feePayer": "Fee payer",
  "field.kind": "Type",
  "field.multisig": "Multisig",
  "field.network": "Network",
  "field.sha256": "SHA-256",
  "field.status": "Status",
  "field.timeLock": "Time lock",
  "field.version": "Version",
  "footer.readOnly": "Read-only: nothing was signed or sent. Generated {time} by Vigil {version}.",
  "heading.balanceChanges": "Balance changes if executed now",
  "heading.batchItem": "Batch item {item}",
  "heading.configActions": "Settings changes",
  "heading.does": "What this proposal does",
  "heading.doesRaw": "What this transaction does",
  "heading.findings": "Findings ({count})",
  "heading.gaps": "Not checked ({count})",
  "heading.noFindings": "Findings (0)",
  "heading.programs": "Programs ({count})",
  "heading.simulation": "Simulation",
  "ix.accounts": "Accounts:",
  "ix.none": "No instructions.",
  "kind.batch": "batch",
  "kind.config": "settings change",
  "kind.vault": "vault transaction",
  "list.analysisFailed": "analysis failed: {error}",
  "list.empty": "No pending proposals among the last {limit} transactions.",
  "list.emptyAll": "No transactions found.",
  "list.hint": "For details: vigil decode {multisig} <index>",
  "list.notAnalysed": "not analysed (no longer pending)",
  "list.summary": "{critical} critical, {warning} warning(s), {info} info, {gaps} gap(s)",
  "list.title": "Proposals of multisig {multisig}",
  "network.value": "{cluster} via {host} · slot {slot}",
  "noFindings.checked": "None of the checks found anything.",
  "program.authorityVault": "upgradeable by Vault #{index} of this multisig ({authority})",
  "program.immutable": "cannot be upgraded",
  "program.lastDeploy": "last deployed at slot {slot}",
  "program.loader": "loader: {loader}",
  "program.native": "built into the validator (not deployed code)",
  "program.repo": "source: {repo}",
  "program.commit": "commit: {commit}",
  "program.hash": "executable hash: {hash}",
  "program.hashMismatch": "the verified build's hash differs from the code deployed now",
  "program.unknownUpgrade": "upgrade authority unknown",
  "program.upgradeable": "upgradeable by {authority}",
  "program.verification": "verification: {status}",
  "program.verifiedAt": "verified at: {time}",
  "proposalStatus.Active": "Active",
  "proposalStatus.Approved": "Approved",
  "proposalStatus.Cancelled": "Cancelled",
  "proposalStatus.Draft": "Draft",
  "proposalStatus.Executed": "Executed",
  "proposalStatus.Executing": "Executing",
  "proposalStatus.Rejected": "Rejected",
  "progress.annotate": "Reading token accounts and labels…",
  "progress.balances": "Reading balances…",
  "progress.cluster": "Connecting to {host}…",
  "progress.cross-check": "Comparing accounts with the second RPC…",
  "progress.decode": "Decoding instructions…",
  "progress.history": "Reading the vault's recent transactions…",
  "progress.list": "Analysing proposal #{index} ({n} of {total})…",
  "progress.programs": "Reading program accounts…",
  "progress.proposal": "Reading the multisig and the proposal…",
  "progress.rules": "Running the checks…",
  "progress.simulate": "Simulating…",
  "progress.verification": "Asking verify.osec.io about the programs…",
  "raw.title": "Raw transaction",
  "severity.critical": "CRITICAL",
  "severity.info": "INFO",
  "severity.warning": "WARNING",
  "simulation.failed": "The simulation failed: {error}",
  "simulation.logs": "Program logs:",
  "simulation.notes": "How to read this:",
  "simulation.unavailable": "Simulation not available: {reason}",
  "snapshot.title": "SNAPSHOT, NOT A GUARANTEE",
  stale: "stale: can no longer be approved or executed",
  "status.none": "no proposal account yet",
  "status.value": "{status} ({time})",
  "status.valueNoTime": "{status}",
  "title.proposal": "Squads v4 proposal #{index} ({kind})",
  "verify.title": "Program {program}",
  "votes.value":
    "{approved} approved, {rejected} rejected; {threshold} of {members} members needed",
} as const;

export type MessageKey = keyof typeof en;

export const MESSAGES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = {
  en,
};

export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key);
}

export function m(
  locale: Locale,
  key: MessageKey,
  params: Readonly<Record<string, string>> = {},
): string {
  return MESSAGES[locale][key].replace(
    /\{([A-Za-z]+)\}/g,
    (_match, name: string) => params[name] ?? "",
  );
}

/** A core catalog text (verdicts, gaps, verification states, proposal statuses...). */
export function core(
  locale: Locale,
  key: string,
  params: Readonly<Record<string, string>> = {},
): string {
  return CATALOGS[locale][key] === undefined && CATALOGS.en[key] === undefined
    ? key
    : coreText(key, locale, params);
}
