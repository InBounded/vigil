import {
  type AnalysisReport,
  type DecodedInstruction,
  type Finding,
  findRegistryProgram,
  groupBalanceChanges,
  type ProgramInfo,
  RULES,
  renderConfigAction,
  renderFinding,
  renderGap,
  renderLabel,
  renderSimulationNotes,
  renderSummary,
  type SimulationResult,
  serializeReport,
  toStableJson,
} from "@vigil-sol/core";
import { useId } from "react";
import {
  Address,
  ClusterContext,
  PoisonContext,
  TextWithAddresses,
} from "../components/Address.js";
import { CopyButton } from "../components/CopyButton.js";
import { SeverityBadge, VERDICT_SYMBOL } from "../components/Severity.js";
import { useMessages } from "../i18n/locale.js";
import { keyed } from "../lib/keyed.js";
import { orderFindings } from "../lib/order.js";
import { safeText } from "../lib/safe-text.js";
import {
  changeAmount,
  changeNotes,
  core,
  FULL,
  isoMinutes,
  poisonedAddresses,
  unixTime,
  upgradeText,
  verificationText,
} from "./format.js";
import { reportToText } from "./text.js";

const WHY = new Map(RULES.map((rule) => [rule.id, rule.docs.why]));

/**
 * A report, in the order a signer needs it: verdict, the re-analyze notice, findings, what it
 * does, balance changes, programs, then technical details (collapsed) and the copy buttons. Only
 * presents `report`: nothing here judges the transaction.
 */
export function ReportView({
  report,
  onReanalyze,
  requestedCluster,
}: {
  readonly report: AnalysisReport;
  readonly onReanalyze: () => void;
  readonly requestedCluster?: string;
}) {
  const { m, locale } = useMessages();
  return (
    <ClusterContext value={report.cluster}>
      <PoisonContext value={poisonedAddresses(report)}>
        <article className="report">
          <ReportHeader report={report} />
          {requestedCluster !== undefined && requestedCluster !== report.cluster ? (
            <p className="note note-warning">
              {m("report.networkMismatch", {
                actual: m(clusterKey(report.cluster)),
                requested: m(clusterKey(requestedCluster)),
              })}
            </p>
          ) : null}
          <VerdictBanner report={report} onReanalyze={onReanalyze} />
          <p className="notice-reanalyze">
            <span aria-hidden="true">↻ </span>
            {m("notice.reanalyze")}
          </p>
          <Findings report={report} />
          <Gaps report={report} />
          <Effects report={report} />
          <BalanceChanges report={report} />
          <Programs programs={report.programs} />
          <TechnicalDetails report={report} />
          <div className="copy-actions">
            <CopyButton
              text={serializeReport(report)}
              label={m("copy.json")}
              copiedLabel={m("copy.done")}
              failedLabel={m("copy.failed")}
              className="button"
            />
            <CopyButton
              text={reportToText(report, locale)}
              label={m("copy.text")}
              copiedLabel={m("copy.done")}
              failedLabel={m("copy.failed")}
              className="button"
            />
          </div>
        </article>
      </PoisonContext>
    </ClusterContext>
  );
}

function clusterKey(cluster: string) {
  return cluster === "mainnet"
    ? "cluster.mainnet"
    : cluster === "devnet"
      ? "cluster.devnet"
      : cluster === "testnet"
        ? "cluster.testnet"
        : "cluster.unknown";
}

function ReportHeader({ report }: { readonly report: AnalysisReport }) {
  const { m } = useMessages();
  const input = report.input;
  const proposal = report.proposal;
  return (
    <header className="report-header">
      <h1>
        {input.kind === "squads-proposal"
          ? m("report.title.proposal", {
              index: input.transactionIndex.toString(),
              kind: m(`kind.${report.transactionKind ?? "vault"}`),
            })
          : m("raw.title")}
      </h1>
      <dl className="fields">
        {input.kind === "squads-proposal" ? (
          <>
            <dt>{m("field.multisig")}</dt>
            <dd>
              <Address address={input.multisig} links />
            </dd>
            {proposal === undefined ? null : (
              <>
                <dt>{m("field.status")}</dt>
                <dd>
                  {proposal.status === null
                    ? m("proposalStatus.none")
                    : `${m(`proposalStatus.${proposal.status.kind}`)}${
                        proposal.status.timestamp === null
                          ? ""
                          : ` (${unixTime(proposal.status.timestamp)})`
                      }`}
                  {proposal.isStale ? ` · ${m("proposalStatus.stale")}` : ""}
                </dd>
                {report.multisig === undefined ? null : (
                  <>
                    <dt>{m("field.approvals")}</dt>
                    <dd>
                      {m("report.approvals", {
                        approved: String(proposal.votes?.approved.length ?? 0),
                        members: String(report.multisig.members.length),
                        rejected: String(proposal.votes?.rejected.length ?? 0),
                        threshold: String(report.multisig.threshold),
                      })}
                    </dd>
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <dt>{m("field.sha256")}</dt>
            <dd>
              <code className="hash">{input.sha256}</code>
            </dd>
            {report.rawTransaction === undefined ? null : (
              <>
                <dt>{m("field.feePayer")}</dt>
                <dd>
                  <Address address={report.rawTransaction.feePayer} links />
                </dd>
                <dt>{m("field.version")}</dt>
                <dd>{String(report.rawTransaction.version)}</dd>
              </>
            )}
          </>
        )}
        <dt>{m("field.network")}</dt>
        <dd>
          {m("report.network", { cluster: m(clusterKey(report.cluster)), host: report.rpcHost })}
        </dd>
      </dl>
    </header>
  );
}

function VerdictBanner({
  report,
  onReanalyze,
}: {
  readonly report: AnalysisReport;
  readonly onReanalyze: () => void;
}) {
  const { m, locale } = useMessages();
  const id = useId();
  const verdict = report.verdict;
  return (
    <section className={`verdict verdict-${verdict}`} aria-labelledby={id}>
      <h2 id={id} className="verdict-title">
        <span className="visually-hidden">{m("verdict.banner.label")}: </span>
        <span aria-hidden="true" className="verdict-symbol">
          {VERDICT_SYMBOL[verdict]}
        </span>{" "}
        {core(locale, `verdict.${verdict}`)}
      </h2>
      <p>{core(locale, `verdict.${verdict}.detail`)}</p>
      <p className="verdict-meta">
        {m("report.analysedAt", {
          slot: report.contextSlot.toString(),
          time: isoMinutes(report.generatedAt),
        })}
      </p>
      <button type="button" className="button" onClick={onReanalyze}>
        {m("report.reanalyze")}
      </button>
    </section>
  );
}

function Findings({ report }: { readonly report: AnalysisReport }) {
  const { m } = useMessages();
  const id = useId();
  const findings = orderFindings(report.findings);
  return (
    <section aria-labelledby={id} className="section">
      <h2 id={id}>{m("report.findings", { count: String(findings.length) })}</h2>
      {findings.length === 0 ? (
        <p>{m("report.findings.none")}</p>
      ) : (
        <ul className="findings">
          {keyed(
            findings,
            (f) => `${f.ruleId}:${f.instructionIndex ?? ""}:${JSON.stringify(f.params)}`,
          ).map(({ key, item: finding }) => (
            <FindingItem key={key} finding={finding} instructions={report.instructions} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FindingItem({
  finding,
  instructions,
}: {
  readonly finding: Finding;
  readonly instructions: readonly DecodedInstruction[];
}) {
  const { m, locale } = useMessages();
  const text = safeText(renderFinding(finding, locale, instructions, FULL).text);
  const why = WHY.get(finding.ruleId);
  const { address, resembles } = finding.params;
  const poisoning =
    finding.ruleId === "VGL-C008" && address !== undefined && resembles !== undefined;
  return (
    <li className={`finding finding-${finding.severity}`}>
      <p className="finding-head">
        <SeverityBadge severity={finding.severity} />{" "}
        <span className="rule-id">{finding.ruleId}</span>
      </p>
      <p className="finding-text">
        <TextWithAddresses text={text} />
      </p>
      {poisoning ? (
        <div className="poison-compare">
          <Address address={address} compareWith={resembles} links />
          <Address address={resembles} compareWith={address} links />
        </div>
      ) : null}
      {why === undefined ? null : (
        <p className="finding-why">
          <strong>{m("report.whyItMatters")}:</strong> {why}
        </p>
      )}
      {finding.evidence.length === 0 ? null : (
        <details className="evidence">
          <summary>{m("report.evidence")}</summary>
          <ul>
            {keyed(finding.evidence, (line) => line).map(({ key, item: line }) => (
              <li key={key}>
                <code>{safeText(line)}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function Gaps({ report }: { readonly report: AnalysisReport }) {
  const { m, locale } = useMessages();
  const id = useId();
  const gaps = report.completeness.gaps;
  if (gaps.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  const unique = gaps.filter((gap) => {
    const key = `${gap.code}|${gap.address ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return (
    <section aria-labelledby={id} className="section gaps">
      <h2 id={id}>{m("report.gaps", { count: String(gaps.length) })}</h2>
      <p>{m("report.gaps.help")}</p>
      <ul>
        {keyed(unique, (gap) => `${gap.code}:${gap.address ?? ""}`).map(({ key, item: gap }) => (
          <li key={key}>
            <span aria-hidden="true">? </span>
            {renderGap(gap, locale)}
            {gap.address === undefined ? null : (
              <>
                {" "}
                <Address address={gap.address} />
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Effects({ report }: { readonly report: AnalysisReport }) {
  const { m, locale } = useMessages();
  const id = useId();
  const heading = report.input.kind === "raw-transaction" ? "report.doesRaw" : "report.does";
  if (report.configActions !== undefined) {
    return (
      <section aria-labelledby={id} className="section">
        <h2 id={id}>{m(heading)}</h2>
        <h3>{m("report.configActions")}</h3>
        <ol className="effects">
          {keyed(report.configActions, (action) => toStableJson(action)).map(
            ({ key, item: action }) => (
              <li key={key}>
                <TextWithAddresses
                  text={safeText(
                    renderConfigAction(
                      action,
                      locale,
                      { instructions: report.instructions, tokens: report.tokens },
                      FULL,
                    ).text,
                  )}
                />
              </li>
            ),
          )}
        </ol>
      </section>
    );
  }
  const items = groupByBatchItem(report.instructions);
  return (
    <section aria-labelledby={id} className="section">
      <h2 id={id}>{m(heading)}</h2>
      {report.instructions.length === 0 ? <p>{m("report.noInstructions")}</p> : null}
      {items.map(({ batchItem, instructions }) => (
        <div key={batchItem ?? "all"}>
          {batchItem === undefined ? null : (
            <h3>{m("report.batchItem", { item: String(batchItem) })}</h3>
          )}
          <InstructionList instructions={instructions} />
        </div>
      ))}
    </section>
  );
}

function groupByBatchItem(instructions: readonly DecodedInstruction[]) {
  const groups: { batchItem: number | undefined; instructions: DecodedInstruction[] }[] = [];
  for (const instruction of instructions) {
    const last = groups.at(-1);
    if (last !== undefined && last.batchItem === instruction.batchItem) {
      last.instructions.push(instruction);
    } else {
      groups.push({ batchItem: instruction.batchItem, instructions: [instruction] });
    }
  }
  return groups;
}

function InstructionList({
  instructions,
  inner = false,
}: {
  readonly instructions: readonly DecodedInstruction[];
  readonly inner?: boolean;
}) {
  const { m, locale } = useMessages();
  return (
    <ol className={inner ? "effects effects-inner" : "effects"}>
      {keyed(instructions, (ix) => `${ix.batchItem ?? ""}:${ix.index}`).map(
        ({ key, item: instruction }) => (
          <li key={key} value={inner ? undefined : instruction.index + 1}>
            <TextWithAddresses text={safeText(renderSummary(instruction, locale, FULL).text)} />
            {instruction.sanitizer === undefined || instruction.sanitizer.length === 0 ? null : (
              <p className="note note-warning">
                {m("report.sanitized", {
                  flags: [...new Set(instruction.sanitizer.flatMap((note) => note.flags))].join(
                    ", ",
                  ),
                })}
              </p>
            )}
            {instruction.inner === undefined || instruction.inner.length === 0 ? null : (
              <div className="inner">
                <p className="inner-title">{m("report.inner")}</p>
                <InstructionList instructions={instruction.inner} inner />
              </div>
            )}
          </li>
        ),
      )}
    </ol>
  );
}

function BalanceChanges({ report }: { readonly report: AnalysisReport }) {
  const { m, locale } = useMessages();
  const id = useId();
  const outcome = report.simulation;
  if (outcome === undefined) {
    return null;
  }
  const [snapshot, ...notes] = renderSimulationNotes(
    outcome,
    locale,
    report.instructions,
    FULL,
  ).map((note) => safeText(note.text));
  const results = outcome.status === "batch" ? outcome.items : [outcome];
  return (
    <section aria-labelledby={id} className="section">
      <h2 id={id}>{m("report.balanceChanges")}</h2>
      <div className="snapshot" role="note">
        <p className="snapshot-title">
          <span aria-hidden="true">⚠ </span>
          {m("report.snapshot")}
        </p>
        <p>{snapshot}</p>
      </div>
      {keyed(results, (result) => String(result.batchItem ?? "all")).map(
        ({ key, item: result }) => (
          <div key={key}>
            {result.batchItem === undefined ? null : (
              <h3>{m("report.batchItem", { item: String(result.batchItem) })}</h3>
            )}
            <SimulationResultView result={result} report={report} />
          </div>
        ),
      )}
      {notes.length === 0 ? null : (
        <>
          <h3>{m("report.simulation.notes")}</h3>
          <ul>
            {keyed(notes, (note) => note).map(({ key, item: note }) => (
              <li key={key}>
                <TextWithAddresses text={note} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function SimulationResultView({
  result,
  report,
}: {
  readonly result: SimulationResult;
  readonly report: AnalysisReport;
}) {
  const { m, locale } = useMessages();
  if (result.status === "unavailable") {
    return <p>{m("report.simulation.unavailable", { reason: safeText(result.reason) })}</p>;
  }
  if (result.status === "failed") {
    return (
      <p className="note note-critical">
        {m("report.simulation.failed", { error: safeText(result.error) })}
      </p>
    );
  }
  if (result.balanceChanges.length === 0) {
    return <p>{m("balance.none")}</p>;
  }
  return (
    <ul className="balances">
      {groupBalanceChanges(result.balanceChanges).map((group) => {
        const holderLabel = group.changes[0]?.holderLabel;
        return (
          <li key={group.holder}>
            <Address
              address={group.holder}
              label={
                holderLabel === undefined ? undefined : renderLabel(holderLabel, locale, false)
              }
              links
            />
            <ul>
              {group.changes.map((change) => {
                const notes = changeNotes(change, locale);
                return (
                  <li key={`${change.account}-${change.asset}`}>
                    <span className="amount">{changeAmount(change, report.tokens, locale)}</span>
                    {notes.length === 0 ? null : ` (${notes.join("; ")})`}
                    {change.owner === undefined ? null : (
                      <span className="balance-account">
                        {m("balance.tokenAccount")} <Address address={change.account} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function Programs({ programs }: { readonly programs: readonly ProgramInfo[] }) {
  const { m, locale } = useMessages();
  const id = useId();
  if (programs.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={id} className="section">
      <h2 id={id}>{m("report.programs", { count: String(programs.length) })}</h2>
      <ul className="programs">
        {programs.map((program) => (
          <li key={program.address}>
            <Address
              address={program.address}
              label={findRegistryProgram(program.address)?.name}
              links
            />
            <ul className="facts">
              <li>
                {upgradeText(program, locale)}
                {program.upgrade.kind === "upgradeable" ? (
                  <>
                    {" "}
                    · {m("program.upgradeAuthority")}:{" "}
                    <Address address={program.upgrade.authority} links />
                  </>
                ) : null}
              </li>
              <li>{verificationText(program, locale)}</li>
              {program.verificationDetails?.hashMismatch === true ? (
                <li className="note-critical">{m("program.hashMismatch")}</li>
              ) : null}
              {program.lastDeploySlot === undefined ? null : (
                <li>{m("program.lastDeploy", { slot: program.lastDeploySlot.toString() })}</li>
              )}
              {program.executableHash === undefined ? null : (
                <li>
                  {m("program.hash")}: <code className="hash">{program.executableHash}</code>
                </li>
              )}
              {program.verificationDetails?.repoUrl === undefined ? null : (
                <li>
                  {m("program.repo")}: <code>{safeText(program.verificationDetails.repoUrl)}</code>
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TechnicalDetails({ report }: { readonly report: AnalysisReport }) {
  const { m, locale } = useMessages();
  const outcome = report.simulation;
  const runs = outcome === undefined ? [] : outcome.status === "batch" ? outcome.items : [outcome];
  const flat: DecodedInstruction[] = [];
  const visit = (list: readonly DecodedInstruction[]) => {
    for (const instruction of list) {
      flat.push(instruction);
      visit(instruction.inner ?? []);
    }
  };
  visit(report.instructions);
  return (
    <details className="section technical">
      <summary>
        <h2>{m("report.technical")}</h2>
      </summary>
      {keyed(flat, (ix) => `${ix.batchItem ?? ""}:${ix.index}`).map(
        ({ key, item: instruction }) => (
          <section key={key} className="technical-instruction">
            <h3>
              {instruction.index + 1}. {safeText(instruction.name ?? "?")}
            </h3>
            <p>
              <Address address={instruction.programId} label={instruction.programLabel} links />
            </p>
            <p>{m("report.technical.decoder", { decoder: instruction.decoder })}</p>
            <h4>{m("report.technical.accounts")}</h4>
            <ol className="accounts">
              {keyed(instruction.accounts, (account) => account.address).map(
                ({ key, item: account }) => (
                  <li key={key}>
                    <span className="role">{safeText(account.role ?? "?")}</span>{" "}
                    <Address
                      address={account.address}
                      label={
                        account.label === undefined
                          ? undefined
                          : renderLabel(account.label, locale, false)
                      }
                    />{" "}
                    {[
                      account.isSigner ? m("report.technical.signer") : "",
                      account.isWritable ? m("report.technical.writable") : "",
                    ]
                      .filter((flag) => flag !== "")
                      .join(", ")}
                    {account.fromLookupTable === undefined ? null : (
                      <>
                        {" "}
                        ({m("report.technical.lookupTable")}{" "}
                        <Address address={account.fromLookupTable} />)
                      </>
                    )}
                  </li>
                ),
              )}
            </ol>
            {instruction.args === undefined ? null : (
              <>
                <h4>{m("report.technical.args")}</h4>
                <pre>{safeText(toStableJson(instruction.args))}</pre>
              </>
            )}
            <h4>{m("report.technical.raw")}</h4>
            <pre className="raw">{instruction.rawDataHex}</pre>
          </section>
        ),
      )}
      {keyed(runs, (run) => `logs:${run.batchItem ?? "all"}`).map(({ key, item: run }) =>
        run.status === "unavailable" || run.logs.length === 0 ? null : (
          <section key={key}>
            <h3>
              {m("report.technical.logs")}
              {run.batchItem === undefined
                ? ""
                : ` · ${m("report.batchItem", { item: String(run.batchItem) })}`}
            </h3>
            <pre className="logs">{run.logs.map((line) => safeText(line)).join("\n")}</pre>
          </section>
        ),
      )}
    </details>
  );
}
