import type { Address as AddressType } from "@solana/kit";
import {
  type AnalysisReport,
  analyzeProposal,
  formatDuration,
  renderFinding,
  type SquadsProposalListEntry,
  VerificationCache,
} from "@vigil-sol/core";
import { useEffect, useId, useRef, useState } from "react";
import { type Endpoints, resolveEndpoints } from "../analysis/endpoints.js";
import {
  isPending,
  loadMultisigOverview,
  MAX_PROPOSALS,
  type MultisigOverview,
  PROPOSALS_PAGE,
} from "../analysis/multisig.js";
import { analysisDependencies, analysisOptions } from "../analysis/options.js";
import { useAnalysis } from "../analysis/use-analysis.js";
import { Address, ClusterContext, TextWithAddresses } from "../components/Address.js";
import { ErrorPanel } from "../components/ErrorPanel.js";
import { NeedRpc } from "../components/NeedRpc.js";
import { SeverityBadge, VERDICT_SYMBOL } from "../components/Severity.js";
import { useEnvironment } from "../env/context.js";
import { useMessages } from "../i18n/locale.js";
import { keyed } from "../lib/keyed.js";
import { formatRoute, type Route, type WebCluster } from "../lib/routes.js";
import { safeText } from "../lib/safe-text.js";
import { core, FULL } from "../report/format.js";
import { useSettings } from "../settings/context.js";

type MultisigRoute = Extract<Route, { name: "multisig" }>;

type RowState =
  | { readonly status: "waiting" }
  | { readonly status: "analysing" }
  | { readonly status: "done"; readonly report: AnalysisReport }
  | { readonly status: "failed" };

export default function MultisigScreen({ route }: { readonly route: MultisigRoute }) {
  const { settings } = useSettings();
  const endpoints = resolveEndpoints(settings, route.cluster);
  if (!endpoints.ok) {
    return <NeedRpc />;
  }
  return <MultisigRunner route={route} endpoints={endpoints} />;
}

function MultisigRunner({
  route,
  endpoints,
}: {
  readonly route: MultisigRoute;
  readonly endpoints: Extract<Endpoints, { ok: true }>;
}) {
  const environment = useEnvironment();
  const { settings } = useSettings();
  const { m } = useMessages();
  const [limit, setLimit] = useState(PROPOSALS_PAGE);
  const settingsKey = `${formatRoute(route)}|${JSON.stringify(settings)}`;
  const { state, rerun } = useAnalysis<MultisigOverview>(`${settingsKey}|${limit}`, async () => {
    const analysis = await environment.analysis();
    return loadMultisigOverview(
      analysis.createRpc(endpoints.url),
      analysis.clock,
      route.multisig,
      limit,
    );
  });
  // While "Load more" reads a longer list, the current one stays on screen (same settings only).
  const last = useRef<{ readonly key: string; readonly value: MultisigOverview } | undefined>(
    undefined,
  );
  if (state.status === "done") {
    last.current = { key: settingsKey, value: state.value };
  }
  const overview =
    state.status === "done"
      ? state.value
      : last.current?.key === settingsKey
        ? last.current.value
        : undefined;
  const rows = useProgressiveAnalysis(
    settingsKey,
    route.multisig,
    route.cluster,
    endpoints,
    overview?.entries,
  );
  if (state.status === "error") {
    return <ErrorPanel error={state.error} onRetry={rerun} />;
  }
  if (overview === undefined) {
    return (
      <p className="loading" role="status">
        {m("step.read")}…
      </p>
    );
  }
  return (
    <ClusterContext value={overview.cluster}>
      <article className="multisig">
        <h1>{m("multisig.title")}</h1>
        <p>
          <Address address={route.multisig} links />
        </p>
        <Summary overview={overview} />
        <Proposals
          overview={overview}
          route={route}
          rows={rows}
          limit={limit}
          loadingMore={state.status === "running"}
          onLoadMore={() => setLimit((n) => Math.min(n + PROPOSALS_PAGE, MAX_PROPOSALS))}
        />
      </article>
    </ClusterContext>
  );
}

/**
 * Analyses the pending proposals among `entries` one at a time (as `vigil list`), sharing one
 * verification cache. Results are kept per settings key, so "Load more" only analyses the newly
 * listed proposals. A result that arrives after this loop was stopped (settings changed, "Load
 * more", page left) is dropped; the next loop analyses that proposal again.
 */
function useProgressiveAnalysis(
  key: string,
  multisig: AddressType,
  cluster: WebCluster,
  endpoints: Extract<Endpoints, { ok: true }>,
  entries: readonly SquadsProposalListEntry[] | undefined,
): ReadonlyMap<bigint, RowState> {
  const environment = useEnvironment();
  const { settings } = useSettings();
  const [rows, setRows] = useState<{ key: string; map: ReadonlyMap<bigint, RowState> }>({
    key,
    map: new Map(),
  });
  // What the loop reads, refreshed on every render; only `key` and the pending list restart it.
  const context = useRef({ cluster, endpoints, environment, multisig, rows, settings });
  context.current = { cluster, endpoints, environment, multisig, rows, settings };
  const pending = (entries ?? [])
    .filter(isPending)
    .map((entry) => entry.transactionIndex)
    .join(",");
  useEffect(() => {
    if (pending === "") {
      return;
    }
    let active = true;
    const set = (index: bigint, row: RowState) => {
      if (active) {
        setRows((previous) => {
          const map = new Map(previous.key === key ? previous.map : []);
          map.set(index, row);
          return { key, map };
        });
      }
    };
    (async () => {
      const { cluster, endpoints, environment, multisig, settings } = context.current;
      const analysis = await environment.analysis();
      const deps = analysisDependencies(analysis, endpoints, new VerificationCache(analysis.clock));
      for (const index of pending.split(",").map((text) => BigInt(text))) {
        const known = context.current.rows;
        const row = known.key === key ? known.map.get(index) : undefined;
        if (!active) {
          return;
        }
        if (row?.status === "done" || row?.status === "failed") {
          continue;
        }
        set(index, { status: "analysing" });
        try {
          const report = await analyzeProposal(
            deps,
            { multisig, transactionIndex: index },
            analysisOptions(settings, cluster),
          );
          set(index, { report, status: "done" });
        } catch {
          set(index, { status: "failed" });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [key, pending]);
  return rows.key === key ? rows.map : new Map();
}

function Summary({ overview }: { readonly overview: MultisigOverview }) {
  const { m, locale } = useMessages();
  const { settings } = useSettings();
  const id = useId();
  const { multisig } = overview;
  const labels = new Map(settings.knownAddresses.map((entry) => [entry.address, entry.label]));
  return (
    <section aria-labelledby={id} className="section">
      <h2 id={id}>{m("multisig.summary")}</h2>
      <dl className="fields">
        <dt>{m("field.threshold")}</dt>
        <dd>
          {m("multisig.threshold", {
            members: String(multisig.members.length),
            threshold: String(multisig.threshold),
          })}
        </dd>
        <dt>{m("field.timeLock")}</dt>
        <dd>
          {multisig.timeLockSeconds === 0
            ? m("multisig.timeLock.none")
            : formatDuration(BigInt(multisig.timeLockSeconds), locale)}
        </dd>
        <dt>{m("field.configAuthority")}</dt>
        <dd>
          {multisig.isControlled ? (
            <Address address={multisig.configAuthority} links />
          ) : (
            m("multisig.autonomous")
          )}
        </dd>
        <dt>{m("field.transactionIndex")}</dt>
        <dd>{multisig.transactionIndex.toString()}</dd>
      </dl>
      <h3>{m("multisig.fragility")}</h3>
      {overview.health.length === 0 ? (
        <p>{m("multisig.fragility.none")}</p>
      ) : (
        <ul className="findings">
          {keyed(overview.health, (f) => `${f.ruleId}:${JSON.stringify(f.params)}`).map(
            ({ key, item: finding }) => (
              <li key={key} className={`finding finding-${finding.severity}`}>
                <p className="finding-head">
                  <SeverityBadge severity={finding.severity} />{" "}
                  <span className="rule-id">{finding.ruleId}</span>
                </p>
                <p className="finding-text">
                  <TextWithAddresses
                    text={safeText(renderFinding(finding, locale, [], FULL).text)}
                  />
                </p>
              </li>
            ),
          )}
        </ul>
      )}
      <h3>{m("multisig.members.count", { count: String(multisig.members.length) })}</h3>
      <table className="members">
        <thead>
          <tr>
            <th scope="col">{m("address.label")}</th>
            <th scope="col">{m("field.permissions")}</th>
          </tr>
        </thead>
        <tbody>
          {multisig.members.map((member) => (
            <tr key={member.key}>
              <td>
                <Address address={member.key} label={labels.get(member.key)} links />
              </td>
              <td>
                {member.permissions.map((permission) => m(`permission.${permission}`)).join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Proposals({
  overview,
  route,
  rows,
  limit,
  loadingMore,
  onLoadMore,
}: {
  readonly overview: MultisigOverview;
  readonly route: MultisigRoute;
  readonly rows: ReadonlyMap<bigint, RowState>;
  readonly limit: number;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
}) {
  const { m, locale } = useMessages();
  const id = useId();
  const { entries, multisig } = overview;
  const shown = entries.length;
  const more = shown < MAX_PROPOSALS && BigInt(shown) < multisig.transactionIndex;
  return (
    <section aria-labelledby={id} className="section">
      <h2 id={id}>{m("multisig.proposals")}</h2>
      <p>{m("multisig.proposals.help", { limit: String(shown) })}</p>
      {entries.length === 0 ? (
        <p>{m("multisig.proposals.empty", { limit: String(limit) })}</p>
      ) : (
        <ul className="proposals">
          {entries.map((entry) => {
            const row = rows.get(entry.transactionIndex);
            return (
              <li key={entry.transactionIndex.toString()} className="proposal-row">
                <a
                  href={formatRoute({
                    cluster: route.cluster,
                    index: entry.transactionIndex,
                    multisig: route.multisig,
                    name: "proposal",
                  })}
                >
                  {m("multisig.proposals.open", { index: entry.transactionIndex.toString() })}
                </a>
                <span>
                  {entry.transactionKind === null ? "—" : m(`kind.${entry.transactionKind}`)}
                </span>
                <span>
                  {entry.isStale
                    ? m("proposalStatus.stale")
                    : entry.proposal === null
                      ? m("proposalStatus.none")
                      : m(`proposalStatus.${entry.proposal.status.kind}`)}
                </span>
                <span>
                  {m("field.approvals")}: {entry.proposal?.votes.approved.length ?? 0} /{" "}
                  {multisig.threshold}
                </span>
                <span className="proposal-verdict">
                  {!isPending(entry) ? (
                    m("multisig.proposals.notPending")
                  ) : row === undefined || row.status === "waiting" ? (
                    m("multisig.proposals.waiting")
                  ) : row.status === "analysing" ? (
                    m("multisig.proposals.analysing")
                  ) : row.status === "failed" ? (
                    m("multisig.proposals.failed")
                  ) : (
                    <span className={`verdict-chip verdict-chip-${row.report.verdict}`}>
                      <span aria-hidden="true">{VERDICT_SYMBOL[row.report.verdict]} </span>
                      {core(locale, `verdict.${row.report.verdict}`)}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {more || loadingMore ? (
        <button
          type="button"
          className="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          aria-busy={loadingMore}
        >
          {loadingMore ? m("loading") : m("multisig.proposals.loadMore")}
        </button>
      ) : null}
    </section>
  );
}
