import type { Command } from "./args.js";

const GLOBAL = `Options (every command):
  --rpc <url>              RPC endpoint without a key (https://host). An endpoint with an
                           API key must be set in VIGIL_RPC_URL instead. Default: the
                           public RPC of --cluster.
  --cross-check-rpc <url>  Second, independent RPC to compare critical accounts with
                           (or VIGIL_CROSS_CHECK_RPC_URL).
  --cluster mainnet|devnet Picks the default RPC only; the real network is always
                           confirmed from the RPC's genesis hash. Default: mainnet.
  --json                   Print machine-readable JSON only (stdout).
  --lang en|pt             Language. Default: from LC_ALL / LC_MESSAGES / LANG, else en.
  --no-simulate            Do not simulate (the analysis is then incomplete).
  --no-external            Do not ask the program-verification API (verify.osec.io).
  --history <N>            Check destinations against the vault's last N transactions
                           (0-1000, default 0 = off). Proposals only.
  --verbose                Also show accounts, evidence, logs and program details.
  --fail-on critical|warning|never
                           What makes the exit code non-zero. Default: critical.
  -h, --help               Show help.   --version   Show the version.`;

const EXIT_CODES = `Exit codes:
  0  nothing at the --fail-on level
  1  warnings (with --fail-on warning)
  2  a critical finding
  3  runtime error or invalid input
  4  the analysis is incomplete and nothing is critical (unless --fail-on never)`;

const ENV = `Environment:
  VIGIL_RPC_URL, VIGIL_CROSS_CHECK_RPC_URL   RPC endpoints (may contain API keys; only
                                             the host is ever shown)
  NO_COLOR                                   Disable colours`;

const OVERVIEW = `Vigil: explains what a Squads v4 proposal or a Solana transaction will do, and flags
risks, before you vote. Read-only: it never signs or sends anything.

Usage:
  vigil decode <multisig> <index>     Analyse a proposal
  vigil decode --tx <base64 | ->      Analyse a base64 transaction (- reads stdin)
  vigil list <multisig>               List proposals with status and a short verdict
  vigil verify <program>              Upgrade authority, last deploy, hash, verification
  vigil watch <multisig>              Watch for new proposals and alert (arrives in a
                                      later version)
  vigil rules                         List every rule
  vigil explain <ruleId>              Explain one rule

Examples:
  npx @vigil-sol/cli decode <multisig> 12
  VIGIL_RPC_URL=https://<provider>/<key> vigil decode <multisig> 12 --json | jq .verdict
  vigil list <multisig> --status all --limit 10

${GLOBAL}

${EXIT_CODES}

${ENV}`;

const COMMAND_HELP: Readonly<Record<Command, string>> = {
  decode: `Usage:
  vigil decode <multisig> <index> [options]
  vigil decode --tx <base64 | -> [options]

Analyses a Squads v4 proposal (the multisig address and the proposal's index, as
shown in Squads), or a serialized base64 transaction (--tx -: read it from stdin).
Shows the verdict, the findings by severity, what the transaction does, the balance
changes of a simulation (a snapshot, not a guarantee) and the programs involved.

${GLOBAL}

${EXIT_CODES}`,
  explain: `Usage:
  vigil explain <ruleId> [--json]

What a rule checks, why it matters, and its known false positives.`,
  list: `Usage:
  vigil list <multisig> [--limit N] [--status active|all] [options]

Lists the multisig's most recent transactions and analyses the pending ones (draft,
active, approved), one at a time, with the same options as vigil decode.
  --limit <N>             How many of the latest transaction indices to look at
                          (1-100, default 20).
  --status active|all     active (default): only pending proposals; all: every
                          transaction, executed ones listed but not analysed.

${GLOBAL}

${EXIT_CODES}`,
  rules: `Usage:
  vigil rules [--json]

Lists every rule with its id and severity. vigil explain <ruleId> for details.`,
  verify: `Usage:
  vigil verify <program> [options]

Shows whether the program can be upgraded and by whom, when it was last deployed, the
hash of its code, and whether verify.osec.io reports a verified build.

${GLOBAL}`,
  watch: `Usage:
  vigil watch <multisig>

Watches a multisig for new proposals and sends alerts. This command arrives in a later
version of Vigil; until then, run vigil list <multisig> on a schedule.`,
};

export function helpText(command: Command | undefined): string {
  return `${command === undefined ? OVERVIEW : COMMAND_HELP[command]}\n`;
}
