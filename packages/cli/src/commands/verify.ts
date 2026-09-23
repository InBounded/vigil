import {
  AnalysisError,
  addVerification,
  detectCluster,
  gatherProgramFacts,
  renderGap,
  toStableJson,
  VerificationCache,
} from "@vigil-sol/core";
import type { ParsedArgs } from "../args.js";
import { CliError } from "../errors.js";
import { m } from "../messages.js";
import { programLines } from "../render.js";
import { exitCodeFrom, type Runtime } from "../runtime.js";
import { wrap } from "../terminal.js";
import { parseAddress } from "../validate.js";

/**
 * What can be known about one program: loader, upgrade authority (or that it cannot change),
 * last deployment slot, solana-verify executable hash, and the verification API's status.
 */
export async function verifyCommand(args: ParsedArgs, runtime: Runtime): Promise<number> {
  const { options } = runtime;
  if (args.positionals.length !== 1) {
    throw new CliError(
      args.positionals.length === 0
        ? "Missing the program address."
        : "Too many arguments for vigil verify.",
      "Usage: vigil verify <program>",
    );
  }
  const program = parseAddress(args.positionals[0], "program address");
  const deps = runtime.analysisDependencies();
  const locale = options.locale;

  let cluster: string;
  try {
    runtime.progress.update(m(locale, "progress.cluster", { host: deps.rpcHost }));
    cluster = detectCluster(await deps.rpc.getGenesisHash());
  } catch {
    runtime.progress.clear();
    throw new AnalysisError("RPC_FAILED", "the RPC endpoint could not be queried");
  }
  runtime.progress.update(m(locale, "progress.programs"));
  const facts = await gatherProgramFacts(deps.rpc, {
    buffers: [],
    programs: [program],
    vaults: [],
  });
  runtime.progress.update(m(locale, "progress.verification"));
  const verified = await addVerification(facts.programs, {
    cache: new VerificationCache(runtime.environment.clock),
    enabled: options.external,
    http: deps.http,
  });
  runtime.progress.clear();
  runtime.noteCluster(cluster);

  const info = verified.programs[0];
  const gaps = [...facts.gaps, ...verified.gaps];
  if (info === undefined || info.loader === "not-a-program") {
    throw new CliError(
      `${program} is not a program: ${gaps[0]?.message ?? "its account is not executable"}.`,
      "Pass the program's own address (the executable account), not a ProgramData, buffer or wallet address.",
    );
  }

  if (options.json) {
    runtime.out(
      `${toStableJson({
        cluster,
        contextSlot: facts.contextSlot,
        gaps,
        program: info,
        rpcHost: deps.rpcHost,
        schemaVersion: 1,
      })}\n`,
    );
  } else {
    const ctx = runtime.renderContext();
    const { style, width } = ctx;
    const out = [
      style.bold(`Vigil · ${m(locale, "verify.title", { program })}`),
      style.dim(`  ${cluster} via ${deps.rpcHost} · slot ${facts.contextSlot}`),
      "",
      ...programLines(info, { ...ctx, verbose: true }),
    ];
    if (gaps.length > 0) {
      out.push("", style.bold(m(locale, "heading.gaps", { count: String(gaps.length) })));
      for (const gap of gaps) {
        out.push(
          ...wrap(renderGap(gap, locale), width, `  ${style.color("yellow", "?")} `, "    "),
        );
        out.push(...wrap(gap.message, width, "    ").map((l) => style.dim(l)));
      }
    }
    runtime.out(`${out.join("\n")}\n`);
  }
  return exitCodeFrom(
    { critical: false, incomplete: gaps.length > 0, warning: false },
    options.failOn,
  );
}
