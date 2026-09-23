import {
  type AnalysisOptions,
  type AnalysisReport,
  analyzeProposal,
  analyzeRawTransaction,
  MAX_RAW_TRANSACTION_BASE64_LENGTH,
  serializeReport,
} from "@vigil-sol/core";
import type { ParsedArgs } from "../args.js";
import { CliError } from "../errors.js";
import { type MessageKey, m } from "../messages.js";
import { renderReport } from "../render.js";
import { exitCodeFor, type Runtime } from "../runtime.js";
import { parseAddress, parseBase64Transaction, parseIndex } from "../validate.js";

/** Room for line breaks and spaces around a pasted transaction on standard input. */
const MAX_STDIN_BYTES = MAX_RAW_TRANSACTION_BASE64_LENGTH + 4096;

export async function decodeCommand(args: ParsedArgs, runtime: Runtime): Promise<number> {
  const { options } = runtime;
  let input:
    | { readonly kind: "raw"; readonly base64: string }
    | {
        readonly kind: "proposal";
        readonly multisig: ReturnType<typeof parseAddress>;
        readonly index: bigint;
      };
  if (args.tx !== undefined) {
    if (args.positionals.length > 0) {
      throw new CliError(
        "vigil decode takes either <multisig> <index> or --tx, not both.",
        "Usage: vigil decode <multisig> <index>   or   vigil decode --tx <base64 | ->",
      );
    }
    if (options.history > 0) {
      throw new CliError(
        "--history applies to Squads proposals only (it reads the vault's history).",
        "Remove --history when analysing a raw transaction.",
      );
    }
    const text =
      args.tx === "-"
        ? await runtime.environment.readStdin(MAX_STDIN_BYTES).catch((error: unknown) => {
            throw new CliError(
              `Could not read the transaction from standard input: ${error instanceof Error ? error.message : "read failed"}.`,
              "Pipe one base64 transaction, e.g. echo <base64> | vigil decode --tx -",
            );
          })
        : args.tx;
    input = { base64: parseBase64Transaction(text), kind: "raw" };
  } else {
    if (args.positionals.length > 2) {
      throw new CliError(
        "Too many arguments for vigil decode.",
        "Usage: vigil decode <multisig> <index>",
      );
    }
    const multisig = parseAddress(args.positionals[0], "multisig address");
    input = { index: parseIndex(args.positionals[1]), kind: "proposal", multisig };
  }

  const deps = runtime.analysisDependencies();
  const analysisOptions: AnalysisOptions = {
    onProgress: (step) =>
      runtime.progress.update(
        m(options.locale, `progress.${step}` as MessageKey, { host: deps.rpcHost }),
      ),
    rules: { historyDepth: options.history },
    simulate: options.simulate,
    verification: options.external,
  };
  let report: AnalysisReport;
  try {
    report =
      input.kind === "raw"
        ? await analyzeRawTransaction(deps, input.base64, analysisOptions)
        : await analyzeProposal(
            deps,
            { multisig: input.multisig, transactionIndex: input.index },
            analysisOptions,
          );
  } finally {
    runtime.progress.clear();
  }
  runtime.noteCluster(report.cluster);
  runtime.out(
    options.json ? `${serializeReport(report)}\n` : renderReport(report, runtime.renderContext()),
  );
  return exitCodeFor(report, options.failOn);
}
