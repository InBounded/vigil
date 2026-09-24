import { parseArgs } from "node:util";
import type { Locale } from "@vigil-sol/core";
import { CliError } from "./errors.js";
import { HISTORY_MAX, parseChoice, parseInteger } from "./validate.js";

export const COMMANDS = ["decode", "list", "verify", "watch", "rules", "explain"] as const;
export type Command = (typeof COMMANDS)[number];

export type FailOn = "critical" | "warning" | "never";

export interface GlobalOptions {
  /** From `--rpc` (a plain endpoint only; see `secrets.ts`). */
  readonly rpcFlag: string | undefined;
  readonly crossCheckRpcFlag: string | undefined;
  readonly cluster: "mainnet" | "devnet";
  readonly clusterGiven: boolean;
  readonly json: boolean;
  readonly locale: Locale;
  readonly simulate: boolean;
  readonly external: boolean;
  readonly history: number;
  readonly verbose: boolean;
  readonly failOn: FailOn;
}

export interface ParsedArgs {
  readonly command: Command | undefined;
  readonly positionals: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
  readonly global: GlobalOptions;
  /** `decode --tx`: base64, or `-` for standard input. */
  readonly tx: string | undefined;
  readonly limit: number;
  readonly status: "active" | "all";
}

const OPTIONS = {
  cluster: { type: "string" },
  "cross-check-rpc": { type: "string" },
  "fail-on": { type: "string" },
  help: { short: "h", type: "boolean" },
  history: { type: "string" },
  json: { type: "boolean" },
  limit: { type: "string" },
  "no-external": { type: "boolean" },
  "no-simulate": { type: "boolean" },
  rpc: { type: "string" },
  status: { type: "string" },
  tx: { type: "string" },
  verbose: { type: "boolean" },
  version: { type: "boolean" },
} as const;

/** Options that only one command takes. */
const COMMAND_ONLY: Readonly<Record<string, Command>> = {
  limit: "list",
  status: "list",
  tx: "decode",
};

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ allowPositionals: true, args: [...argv], options: OPTIONS, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "invalid arguments";
    throw new CliError(message ?? "invalid arguments", "Run vigil --help to see the options.");
  }
  const { values, positionals } = parsed;
  const [first, ...rest] = positionals;
  let command: Command | undefined;
  if (first !== undefined) {
    if (!(COMMANDS as readonly string[]).includes(first)) {
      throw new CliError(
        `Unknown command "${first.replace(/[^\x20-\x7e]/g, "?").slice(0, 40)}".`,
        `Commands: ${COMMANDS.join(", ")}. Run vigil --help for details.`,
      );
    }
    command = first as Command;
  }
  for (const [option, owner] of Object.entries(COMMAND_ONLY)) {
    if (values[option as keyof typeof values] !== undefined && command !== owner) {
      throw new CliError(
        `--${option} only applies to vigil ${owner}.`,
        `Run vigil ${owner} --help to see how to use it.`,
      );
    }
  }

  const failOn = parseChoice(
    values["fail-on"],
    "--fail-on",
    ["critical", "warning", "never"],
    "critical",
  );
  const cluster = parseChoice(values.cluster, "--cluster", ["mainnet", "devnet"], "mainnet");
  const history = parseInteger(values.history, "--history", 0, HISTORY_MAX, 0);
  const limit = parseInteger(values.limit, "--limit", 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  const status = parseChoice(values.status, "--status", ["active", "all"], "active");

  return {
    command,
    global: {
      cluster,
      clusterGiven: values.cluster !== undefined,
      crossCheckRpcFlag: values["cross-check-rpc"],
      external: values["no-external"] !== true,
      failOn,
      history,
      json: values.json === true,
      // English only for now; the text is keyed by locale so another one can be added later.
      locale: "en",
      rpcFlag: values.rpc,
      simulate: values["no-simulate"] !== true,
      verbose: values.verbose === true,
    },
    help: values.help === true,
    limit,
    positionals: rest,
    status,
    tx: values.tx,
    version: values.version === true,
  };
}
