import {
  type AnalysisDependencies,
  type AnalysisReport,
  type RpcClient,
  rpcHostOf,
  VerificationCache,
} from "@vigil-sol/core";
import type { FailOn, GlobalOptions } from "./args.js";
import type { CliEnvironment } from "./environment.js";
import { CliError, EXIT } from "./errors.js";
import { Progress } from "./progress.js";
import type { RenderContext } from "./render.js";
import { checkRpcUrl, type Redactor } from "./secrets.js";
import { createStyle, layoutWidth, type Style } from "./terminal.js";

/** Public endpoints used when no RPC is configured (`docs/reference.md` §3). */
export const DEFAULT_RPC: Readonly<Record<"mainnet" | "devnet", string>> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

/** What every command gets: redacted output, styles, progress, and how to reach the chain. */
export class Runtime {
  readonly environment: CliEnvironment;
  readonly options: GlobalOptions;
  readonly outStyle: Style;
  readonly errStyle: Style;
  readonly progress: Progress;
  readonly #redactor: Redactor;

  constructor(environment: CliEnvironment, options: GlobalOptions, redactor: Redactor) {
    this.environment = environment;
    this.options = options;
    this.#redactor = redactor;
    this.outStyle = createStyle(environment.env, environment.stdout.isTTY && !options.json);
    this.errStyle = createStyle(environment.env, environment.stderr.isTTY);
    this.progress = new Progress(environment.stderr, true);
    // Refuse a secret-bearing flag before anything else can fail and print a message.
    if (options.rpcFlag !== undefined) {
      checkRpcUrl(options.rpcFlag, { flag: "--rpc", fromFlag: true, variable: "VIGIL_RPC_URL" });
    }
    if (options.crossCheckRpcFlag !== undefined) {
      checkRpcUrl(options.crossCheckRpcFlag, {
        flag: "--cross-check-rpc",
        fromFlag: true,
        variable: "VIGIL_CROSS_CHECK_RPC_URL",
      });
    }
  }

  out(text: string): void {
    this.environment.stdout.write(this.#redactor.scrub(text));
  }

  err(text: string): void {
    this.progress.clear();
    this.environment.stderr.write(this.#redactor.scrub(text));
  }

  renderContext(): RenderContext {
    const { stdout } = this.environment;
    return {
      locale: this.options.locale,
      style: this.outStyle,
      verbose: this.options.verbose,
      version: this.environment.version,
      width: layoutWidth(stdout.isTTY, stdout.columns),
    };
  }

  /** The primary RPC: `--rpc` (plain endpoint only), else `VIGIL_RPC_URL`, else the public one. */
  primaryRpc(): { readonly rpc: RpcClient; readonly host: string; readonly url: string } {
    const { env } = this.environment;
    const flag = this.options.rpcFlag;
    const variable = env.VIGIL_RPC_URL;
    let url: string;
    if (flag !== undefined) {
      url = checkRpcUrl(flag, { flag: "--rpc", fromFlag: true, variable: "VIGIL_RPC_URL" }).href;
    } else if (variable !== undefined && variable.trim() !== "") {
      url = checkRpcUrl(variable.trim(), {
        flag: "--rpc",
        fromFlag: false,
        variable: "VIGIL_RPC_URL",
      }).href;
    } else {
      url = new URL(DEFAULT_RPC[this.options.cluster]).href;
    }
    return { host: rpcHostOf(url), rpc: this.environment.createRpc(url), url };
  }

  /** The optional second RPC for the cross-check (VGL-C012). */
  crossCheckRpc(primaryUrl: string): RpcClient | undefined {
    const { env } = this.environment;
    const flag = this.options.crossCheckRpcFlag;
    const variable = env.VIGIL_CROSS_CHECK_RPC_URL;
    let url: string | undefined;
    if (flag !== undefined) {
      url = checkRpcUrl(flag, {
        flag: "--cross-check-rpc",
        fromFlag: true,
        variable: "VIGIL_CROSS_CHECK_RPC_URL",
      }).href;
    } else if (variable !== undefined && variable.trim() !== "") {
      url = checkRpcUrl(variable.trim(), {
        flag: "--cross-check-rpc",
        fromFlag: false,
        variable: "VIGIL_CROSS_CHECK_RPC_URL",
      }).href;
    }
    if (url === undefined) {
      return undefined;
    }
    if (url === primaryUrl) {
      throw new CliError(
        "The cross-check RPC is the same endpoint as the primary RPC, so comparing them proves nothing.",
        "Point VIGIL_CROSS_CHECK_RPC_URL (or --cross-check-rpc) at an independent provider.",
      );
    }
    return this.environment.createRpc(url);
  }

  /** Everything an analysis needs, from the options and the environment. */
  analysisDependencies(verificationCache?: VerificationCache): AnalysisDependencies {
    const primary = this.primaryRpc();
    const crossCheckRpc = this.crossCheckRpc(primary.url);
    return {
      clock: this.environment.clock,
      http: this.environment.createHttp(),
      rpc: primary.rpc,
      rpcHost: primary.host,
      verificationCache: verificationCache ?? new VerificationCache(this.environment.clock),
      ...(crossCheckRpc === undefined ? {} : { crossCheckRpc }),
      ...(this.environment.idlCache === undefined ? {} : { idlCache: this.environment.idlCache }),
    };
  }

  /** Tells the user when `--cluster` disagrees with the network the RPC is really on. */
  noteCluster(actual: string): void {
    if (this.options.clusterGiven && actual !== this.options.cluster) {
      this.err(
        `note: --cluster ${this.options.cluster} was given, but the RPC is on ${actual} (by its genesis hash); the report is about ${actual}.\n`,
      );
    }
  }
}

/** The exit code for one report (see `EXIT`). */
export function exitCodeFor(report: AnalysisReport, failOn: FailOn): number {
  return exitCodeFrom(
    {
      critical: report.findings.some((f) => f.severity === "critical"),
      incomplete: !report.completeness.complete,
      warning: report.findings.some((f) => f.severity === "warning"),
    },
    failOn,
  );
}

export function exitCodeFrom(
  state: { readonly critical: boolean; readonly incomplete: boolean; readonly warning: boolean },
  failOn: FailOn,
): number {
  if (failOn === "never") {
    return EXIT.ok;
  }
  if (state.critical) {
    return EXIT.critical;
  }
  if (state.incomplete) {
    return EXIT.incomplete;
  }
  if (failOn === "warning" && state.warning) {
    return EXIT.warning;
  }
  return EXIT.ok;
}
