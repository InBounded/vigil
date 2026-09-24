import { AnalysisError, RuleOptionsError, WatchError } from "@vigil-sol/core";
import { parseCliArgs } from "./args.js";
import { decodeCommand } from "./commands/decode.js";
import { listCommand } from "./commands/list.js";
import { explainCommand, rulesCommand } from "./commands/rules.js";
import { verifyCommand } from "./commands/verify.js";
import { watchCommand } from "./commands/watch.js";
import type { CliEnvironment } from "./environment.js";
import { CliError, EXIT } from "./errors.js";
import { helpText } from "./help.js";
import { Runtime } from "./runtime.js";
import { Redactor } from "./secrets.js";
import { createStyle } from "./terminal.js";

/** What to do about each analysis error. */
const ANALYSIS_HINTS: Readonly<Record<AnalysisError["code"], string>> = {
  INVALID_TRANSACTION:
    'Pass one serialized transaction as base64, as wallets and getTransaction(..., { encoding: "base64" }) produce it.',
  NOT_A_MULTISIG:
    "Use the multisig address (Squads → Settings), not a vault or member address, and check --cluster / the RPC's network.",
  RPC_FAILED:
    "Check your network, or use another endpoint: set VIGIL_RPC_URL (public endpoints are heavily rate-limited).",
  TRANSACTION_INVALID:
    "The account at that index is not a Squads v4 transaction. Check the multisig address.",
  TRANSACTION_NOT_FOUND:
    "Run vigil list <multisig> --status all to see which transactions exist. Executed or cancelled transactions may have been closed.",
};

const WATCH_HINTS: Readonly<Record<WatchError["code"], string>> = {
  CLUSTER_MISMATCH:
    "Use an RPC on the network the state was recorded on, or a different --state-file for this network.",
  MULTISIG_MISMATCH: "Pass the state file of this multisig, or another --state-file.",
  STATE_INVALID:
    "Fix or move the state file. Removing it makes the next run alert on every pending proposal again.",
};

/**
 * Runs one CLI invocation and returns its exit code. Every byte written goes through the
 * redactor, so no configured RPC URL (which may hold an API key) can be printed.
 */
export async function main(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const redactor = new Redactor();
  redactor.add(environment.env.VIGIL_RPC_URL);
  redactor.add(environment.env.VIGIL_CROSS_CHECK_RPC_URL);
  redactor.add(environment.env.VIGIL_DISCORD_WEBHOOK);
  redactor.add(environment.env.VIGIL_TELEGRAM_BOT_TOKEN);
  for (const arg of argv) {
    const value = arg.includes("=") && arg.startsWith("--") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      redactor.add(value);
    }
  }
  const errorStyle = createStyle(environment.env, environment.stderr.isTTY);
  const fail = (message: string, hint?: string): number => {
    environment.stderr.write(
      redactor.scrub(
        `${errorStyle.color("red", "error:", true)} ${message}\n${hint === undefined ? "" : `  → ${hint}\n`}`,
      ),
    );
    return EXIT.error;
  };

  let runtime: Runtime | undefined;
  try {
    const args = parseCliArgs(argv);
    if (args.version) {
      environment.stdout.write(`${environment.version}\n`);
      return EXIT.ok;
    }
    if (args.help || args.command === undefined) {
      environment.stdout.write(helpText(args.command));
      return EXIT.ok;
    }
    runtime = new Runtime(environment, args.global, redactor);
    switch (args.command) {
      case "decode":
        return await decodeCommand(args, runtime);
      case "list":
        return await listCommand(args, runtime);
      case "verify":
        return await verifyCommand(args, runtime);
      case "rules":
        return rulesCommand(args, runtime);
      case "explain":
        return explainCommand(args, runtime);
      case "watch":
        return await watchCommand(args, runtime);
    }
  } catch (error) {
    runtime?.progress.clear();
    if (error instanceof CliError) {
      return fail(error.message, error.hint);
    }
    if (error instanceof AnalysisError) {
      return fail(sentence(error.message), ANALYSIS_HINTS[error.code]);
    }
    if (error instanceof WatchError) {
      return fail(sentence(error.message), WATCH_HINTS[error.code]);
    }
    if (error instanceof RuleOptionsError) {
      return fail(sentence(error.message));
    }
    const name = error instanceof Error ? error.name : "unknown error";
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      `Unexpected failure (${name}): ${message}`,
      "This is a bug in Vigil. Please report it with the command you ran (without any API key): https://github.com/InBounded/vigil/issues",
    );
  }
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
