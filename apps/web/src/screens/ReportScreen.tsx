import {
  type AnalysisReport,
  analyzeProposal,
  analyzeRawTransaction,
  VerificationCache,
} from "@vigil-sol/core";
import { useEffect, useRef } from "react";
import { type Endpoints, resolveEndpoints } from "../analysis/endpoints.js";
import { analysisDependencies, analysisOptions } from "../analysis/options.js";
import { useAnalysis } from "../analysis/use-analysis.js";
import { ErrorPanel } from "../components/ErrorPanel.js";
import { NeedRpc } from "../components/NeedRpc.js";
import { Progress } from "../components/Progress.js";
import { useEnvironment } from "../env/context.js";
import { formatRoute, type Route } from "../lib/routes.js";
import { ReportView } from "../report/ReportView.js";
import { useSettings } from "../settings/context.js";

export type ReportRoute = Extract<Route, { name: "proposal" | "transaction" }>;

/** The report of one proposal or raw transaction, analysed when the page opens. */
export default function ReportScreen({ route }: { readonly route: ReportRoute }) {
  const { settings } = useSettings();
  const endpoints = resolveEndpoints(settings, route.cluster);
  if (!endpoints.ok) {
    return <NeedRpc />;
  }
  return <ReportRunner route={route} endpoints={endpoints} />;
}

function ReportRunner({
  route,
  endpoints,
}: {
  readonly route: ReportRoute;
  readonly endpoints: Extract<Endpoints, { ok: true }>;
}) {
  const environment = useEnvironment();
  const { settings } = useSettings();
  // A new route, endpoint or settings means a new analysis.
  const key = `${formatRoute(route)}|${JSON.stringify(settings)}`;
  const { state, rerun } = useAnalysis<AnalysisReport>(key, async (onProgress) => {
    const analysis = await environment.analysis();
    const deps = analysisDependencies(analysis, endpoints, new VerificationCache(analysis.clock));
    const options = analysisOptions(settings, route.cluster, onProgress);
    return route.name === "proposal"
      ? analyzeProposal(deps, { multisig: route.multisig, transactionIndex: route.index }, options)
      : analyzeRawTransaction(deps, route.base64, options);
  });
  const heading = useRef<HTMLDivElement>(null);
  const done = state.status === "done";
  useEffect(() => {
    if (done) {
      heading.current?.focus({ preventScroll: true });
    }
  }, [done]);
  if (state.status === "running") {
    return <Progress step={state.step} raw={route.name === "transaction"} />;
  }
  if (state.status === "error") {
    return <ErrorPanel error={state.error} onRetry={rerun} />;
  }
  return (
    <div ref={heading} tabIndex={-1} className="focus-target">
      <ReportView report={state.value} onReanalyze={rerun} requestedCluster={route.cluster} />
    </div>
  );
}
