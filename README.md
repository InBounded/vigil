# Vigil

**Status: in development. No release exists yet. Nothing in this repository should be trusted for real fund decisions until it reaches a tagged, audited release.**

Vigil is an open-source, read-only tool that analyzes [Squads v4](https://squads.so) multisig proposals on Solana, as well as arbitrary base64-encoded Solana transactions, and explains in plain language what they will do when executed — flagging risks by severity — before members vote.

It exists as an independent second opinion. If the official signing interface is ever compromised (as happened to the Safe{Wallet} interface in the 2025 Bybit incident), or simply presents information in a way that is too technical for a signer to act on safely, Vigil reads the transaction data directly from the chain and states plainly what will actually happen.

## What Vigil is

- A read-only decoder and risk-flagging engine (`@vigil-sol/core`) that runs identically in the browser and in Node.js.
- A static web app for signers, most of whom are not developers.
- A CLI for developers, CI pipelines, and alerting.
- MVP scope: Squads v4 proposals and raw base64-encoded transactions. Support for other programs (Squads v3, SPL Governance/Realms) is designed to be added later behind a `MultisigAdapter` interface, without touching decoders, rules, or UIs.

## What Vigil is not

- **Not a wallet.** Vigil never requests, accepts, stores, or processes private keys or seed phrases.
- **Never connects a wallet, never signs, never sends a transaction.** It only reads on-chain data through an allowlisted set of RPC methods.
- **Not a guarantee of safety.** Vigil reports what it was able to verify and how it verified it. It never claims a proposal is "safe" or "secure" — only that specific checks found no issues, or that the analysis was incomplete and why.
- **Not a replacement for the signer's own judgment.** Vigil is a second opinion, not a final authority.

## Command line

> **Not published yet.** The commands below describe the CLI as built; the first npm release comes with a later phase.
>
> The npm package is **`@vigil-sol/cli`** (the command it installs is `vigil`). The unscoped npm package named `vigil` is an **unrelated project by someone else**: `npx vigil …` would download and run that package, not this one. Always type `npx @vigil-sol/cli …`.

Run it without installing anything (Node.js 22 or later):

```sh
npx @vigil-sol/cli decode <multisig> <index>       # analyse a Squads v4 proposal
npx @vigil-sol/cli decode --tx <base64>            # analyse a serialized transaction
pbpaste | npx @vigil-sol/cli decode --tx -         # ... read from standard input
npx @vigil-sol/cli list <multisig>                 # pending proposals and a short verdict
npx @vigil-sol/cli verify <program>                # upgrade authority, last deploy, hash, verified build
npx @vigil-sol/cli rules                           # every rule; explain one with: explain VGL-C001
```

`<multisig>` is the multisig address shown in Squads settings (not a vault address), and `<index>` is the proposal number. The report starts with the verdict, then the findings by severity, what the proposal does, the balance changes of a simulation (**a snapshot of one moment, never a guarantee**) and the programs involved. Every address is shown in full. `--verbose` adds accounts, evidence and logs. Vigil ships in English only.

**RPC endpoints.** By default the public endpoint of `--cluster mainnet|devnet` is used; the real network is always confirmed from the RPC's genesis hash. An endpoint with an API key must be given in an environment variable, never as a flag (flags end up in shell history and process lists), and only its host is ever printed:

```sh
export VIGIL_RPC_URL='https://<provider>/<your-key>'
export VIGIL_CROSS_CHECK_RPC_URL='https://<another-provider>/<key>'   # optional second opinion on the accounts
```

**Automation.** `--json` prints exactly the report (schema: [`docs/report.schema.json`](docs/report.schema.json)) and nothing else; progress messages go to stderr and only on a terminal. For example (with [jq](https://jqlang.org)):

```sh
npx @vigil-sol/cli decode <multisig> <index> --json | jq .verdict
```

| Exit code | Meaning |
|---|---|
| 0 | Nothing at the `--fail-on` level (default `critical`) |
| 1 | Warnings, with `--fail-on warning` |
| 2 | A critical finding |
| 3 | Runtime error or invalid input |
| 4 | The analysis is incomplete and nothing is critical (unless `--fail-on never`) |

Other options: `--no-simulate`, `--no-external` (do not ask the program-verification API), `--history <N>` (compare destinations with the vault's last N transactions), `--fail-on critical|warning|never`, `--limit`/`--status` for `list`. `vigil <command> --help` lists everything. `vigil watch` arrives in a later version.

## Principles

- **Read-only, always.** Only RPC methods on the allowlist in [`docs/reference.md`](docs/reference.md) are used; `simulateTransaction` is only ever called with `sigVerify: false`.
- **No required backend.** Everything runs in the browser or on your machine. The only optional server component is an RPC proxy that forwards allowlisted methods.
- **Zero telemetry.** No analytics, trackers, third-party scripts, external fonts, or network calls beyond the RPC and an optional, disable-able program-verification lookup.
- **Every fact carries its provenance.** Data is labeled `onchain`, `idl-declared`, `external-api`, `simulation`, or `rule-inference`, so you always know how confident to be.
- **Failures are visible.** An incomplete analysis is reported as incomplete — never silently presented as clean.

## Status

This project is in early, phase-by-phase development. See [`AGENTS.md`](AGENTS.md) for the working rules and full project specification, and [`docs/architecture.md`](docs/architecture.md) for the current design.

### Known limitations

- **v1 transactions ([SIMD-0385](https://github.com/solana-foundation/solana-improvement-documents)) and RPC endpoints.** Vigil decodes legacy, v0 and v1 transactions, and asks the RPC for v1. If an RPC endpoint rejects that request, Vigil falls back to legacy/v0 for that endpoint and reports that v1 transactions can't be read through it — the analysis is then marked incomplete, never clean. Use an endpoint that supports v1 to avoid this.

## License

[Apache License 2.0](LICENSE).
