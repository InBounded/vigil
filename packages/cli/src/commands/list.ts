import {
  AnalysisError,
  type AnalysisReport,
  analyzeProposal,
  detectCluster,
  NotASquadsMultisigError,
  reportToJson,
  type SquadsProposalListEntry,
  SquadsV4Adapter,
  toStableJson,
  VerificationCache,
} from "@vigil-sol/core";
import type { ParsedArgs } from "../args.js";
import { CliError } from "../errors.js";
import { core, type MessageKey, m } from "../messages.js";
import { exitCodeFrom, type Runtime } from "../runtime.js";
import { wrap } from "../terminal.js";
import { parseAddress } from "../validate.js";

/** Statuses a proposal can still be voted on or executed from. */
const PENDING = new Set(["Draft", "Active", "Approved", "Executing"]);

interface Row {
  readonly entry: SquadsProposalListEntry;
  readonly pending: boolean;
  readonly report?: AnalysisReport;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * Lists the multisig's most recent transactions (`--limit` indices, newest first) and analyses
 * the pending ones one at a time, with the same options as `vigil decode`. Executed, rejected,
 * cancelled, stale and closed transactions are listed but not analysed: simulating what already
 * happened (or can no longer happen) says nothing useful.
 */
export async function listCommand(args: ParsedArgs, runtime: Runtime): Promise<number> {
  const { options } = runtime;
  if (args.positionals.length !== 1) {
    throw new CliError(
      args.positionals.length === 0
        ? "Missing the multisig address."
        : "Too many arguments for vigil list.",
      "Usage: vigil list <multisig> [--limit N] [--status active|all]",
    );
  }
  const multisig = parseAddress(args.positionals[0], "multisig address");
  const deps = runtime.analysisDependencies(new VerificationCache(runtime.environment.clock));
  const locale = options.locale;

  let cluster: string;
  let entries: readonly SquadsProposalListEntry[];
  try {
    runtime.progress.update(m(locale, "progress.cluster", { host: deps.rpcHost }));
    cluster = detectCluster(await deps.rpc.getGenesisHash());
    runtime.progress.update(m(locale, "progress.proposal"));
    entries = await new SquadsV4Adapter(deps.rpc).listProposals(multisig, { limit: args.limit });
  } catch (error) {
    runtime.progress.clear();
    if (error instanceof NotASquadsMultisigError) {
      throw new AnalysisError("NOT_A_MULTISIG", error.message);
    }
    throw new AnalysisError(
      "RPC_FAILED",
      "the multisig's transactions could not be read from the RPC",
    );
  }
  runtime.noteCluster(cluster);

  const isPending = (entry: SquadsProposalListEntry) =>
    entry.transactionKind !== null &&
    !entry.isStale &&
    (entry.proposal === null || PENDING.has(entry.proposal.status.kind));
  const shown = entries.filter((entry) => args.status === "all" || isPending(entry));
  const toAnalyse = shown.filter(isPending);
  const rows: Row[] = [];
  let n = 0;
  for (const entry of shown) {
    if (!isPending(entry)) {
      rows.push({ entry, pending: false });
      continue;
    }
    n++;
    runtime.progress.update(
      m(locale, "progress.list", {
        index: entry.transactionIndex.toString(),
        n: String(n),
        total: String(toAnalyse.length),
      }),
    );
    try {
      const report = await analyzeProposal(
        deps,
        { multisig, transactionIndex: entry.transactionIndex },
        {
          rules: { historyDepth: options.history },
          simulate: options.simulate,
          verification: options.external,
        },
      );
      rows.push({ entry, pending: true, report });
    } catch (error) {
      const code = error instanceof AnalysisError ? error.code : "UNEXPECTED";
      const message =
        error instanceof AnalysisError ? error.message : "unexpected error during the analysis";
      rows.push({ entry, error: { code, message }, pending: true });
    }
  }
  runtime.progress.clear();

  if (options.json) {
    runtime.out(
      `${toStableJson({
        cluster,
        limit: args.limit,
        multisig,
        proposals: rows.map((row) => ({
          analysed: row.report !== undefined,
          isStale: row.entry.isStale,
          pending: row.pending,
          status: row.entry.proposal?.status.kind ?? null,
          transactionIndex: row.entry.transactionIndex,
          transactionKind: row.entry.transactionKind,
          ...(row.report === undefined ? {} : { report: reportToJson(row.report) }),
          ...(row.error === undefined ? {} : { error: row.error }),
        })),
        rpcHost: deps.rpcHost,
        schemaVersion: 1,
        status: args.status,
      })}\n`,
    );
  } else {
    runtime.out(renderList(rows, multisig, cluster, deps.rpcHost, args, runtime));
  }

  const reports = rows.flatMap((row) => (row.report === undefined ? [] : [row.report]));
  return exitCodeFrom(
    {
      critical: reports.some((r) => r.findings.some((f) => f.severity === "critical")),
      // A proposal that could not be analysed at all leaves the list incomplete.
      incomplete:
        reports.some((r) => !r.completeness.complete) || rows.some((r) => r.error !== undefined),
      warning: reports.some((r) => r.findings.some((f) => f.severity === "warning")),
    },
    options.failOn,
  );
}

const VERDICT_SYMBOL = { attention: "⚠", critical: "✖", incomplete: "?", "no-findings": "○" };
const VERDICT_COLOR = {
  attention: "yellow",
  critical: "red",
  incomplete: "yellow",
  "no-findings": "cyan",
} as const;

function renderList(
  rows: readonly Row[],
  multisig: string,
  cluster: string,
  host: string,
  args: ParsedArgs,
  runtime: Runtime,
): string {
  const ctx = runtime.renderContext();
  const { locale, style, width } = ctx;
  const out = [
    style.bold(`Vigil · ${m(locale, "list.title", { multisig })}`),
    style.dim(`  ${cluster} via ${host}`),
    "",
  ];
  if (rows.length === 0) {
    out.push(
      ...wrap(
        args.status === "all"
          ? m(locale, "list.emptyAll")
          : m(locale, "list.empty", { limit: String(args.limit) }),
        width,
        "  ",
      ),
    );
  }
  for (const row of rows) {
    const { entry } = row;
    const status =
      entry.proposal === null
        ? m(locale, "status.none")
        : m(locale, `proposalStatus.${entry.proposal.status.kind}` as MessageKey);
    const kind =
      entry.transactionKind === null
        ? "—"
        : m(locale, `kind.${entry.transactionKind}` as MessageKey);
    const stale = entry.isStale ? ` · ${m(locale, "stale")}` : "";
    out.push(
      ...wrap(`#${entry.transactionIndex} · ${kind} · ${status}${stale}`, width, "").map((l) =>
        style.bold(l),
      ),
    );
    if (row.report !== undefined) {
      const report = row.report;
      const verdict = report.verdict;
      out.push(
        ...wrap(
          `${VERDICT_SYMBOL[verdict]} ${core(locale, `verdict.${verdict}`)}`,
          width,
          "  ",
        ).map((l) => style.color(VERDICT_COLOR[verdict], l, true)),
      );
      const count = (severity: string) =>
        String(report.findings.filter((f) => f.severity === severity).length);
      out.push(
        ...wrap(
          m(locale, "list.summary", {
            critical: count("critical"),
            gaps: String(report.completeness.gaps.length),
            info: count("info"),
            warning: count("warning"),
          }),
          width,
          "  ",
        ).map((l) => style.dim(l)),
      );
    } else if (row.error !== undefined) {
      out.push(
        ...wrap(m(locale, "list.analysisFailed", { error: row.error.message }), width, "  ").map(
          (l) => style.color("red", l),
        ),
      );
    } else {
      out.push(...wrap(m(locale, "list.notAnalysed"), width, "  ").map((l) => style.dim(l)));
    }
  }
  if (rows.some((row) => row.pending)) {
    out.push("", ...wrap(m(locale, "list.hint", { multisig }), width).map((l) => style.dim(l)));
  }
  return `${out.join("\n")}\n`;
}
