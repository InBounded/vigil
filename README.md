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

## Web app

> **Mainnet needs your own RPC endpoint (product constraint, not a bug).** The public mainnet RPC (`api.mainnet-beta.solana.com`) refuses requests from browser pages it does not know: a hosted page gets `403 Access forbidden`, and a page opened from a local file is blocked by the browser. The web app therefore has **no default mainnet endpoint**: to analyze mainnet proposals in the browser, add your own RPC endpoint in Settings, or use a build made with the optional Vigil RPC proxy (`apps/rpc-proxy`, deployment in `docs/maintainers.md`). Order on mainnet: your own endpoint, then the proxy, else the page asks for an endpoint; the page always says which one is in use. The proxy is shared and rate-limited; what it sees and keeps is in `SECURITY.md`. Devnet works out of the box with the public devnet endpoint. The CLI is not affected.

> **Not deployed yet.** Hosting and release publishing come with a later phase.

A static app for signers: paste a multisig address or a base64 transaction, see the multisig (members, threshold, time lock, weaknesses) and its recent proposals, and open a report that starts with the verdict and says what the proposal does, what it changes (simulation), which programs it touches, and what could not be checked. Every link is shareable (`#/ms/<multisig>/<index>`, `#/tx?data=<base64>`, `&cluster=devnet`) and needs no server. Settings stay in your browser; nothing is sent anywhere except to your RPC endpoint and, unless you turn it off, the program-verification API (`verify.osec.io`).

```sh
pnpm -F @vigil/web dev      # local development server
pnpm -F @vigil/web build    # the three builds below
```

| Build | Folder | For |
|---|---|---|
| Hosted | `apps/web/dist/` | Cloudflare Pages. `public/_headers` sends the Content Security Policy, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and a restrictive `Permissions-Policy`. |
| GitHub Pages mirror | `apps/web/dist-ghpages/` | GitHub Pages cannot send custom headers, so the CSP is a `<meta>` tag. **`frame-ancestors` has no effect in a `<meta>` CSP and `X-Frame-Options` cannot be set there, so the mirror cannot prevent being framed (clickjacking); prefer the hosted build.** A GitHub Pages user site also shares its storage with every other page under the same `*.github.io` origin. |
| Offline file | `apps/web/dist-offline/vigil-offline-<version>.html` | One self-contained HTML file to open from your disk, with its SHA-256 next to it (`sha256sum -c vigil-offline-<version>.html.sha256`). Its inline script and style are allowed by their SHA-256 in its `<meta>` CSP, so a modified file does not run. RPC endpoints you enter there are kept only until you close it: other local files opened in the same browser could read stored ones. |

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

Other options: `--no-simulate`, `--no-external` (do not ask the program-verification API), `--history <N>` (compare destinations with the vault's last N transactions), `--fail-on critical|warning|never`, `--limit`/`--status` for `list`. `vigil <command> --help` lists everything.

### Watching a multisig

`vigil watch` alerts your team as soon as a new proposal appears (before anyone approves) and when a proposal is approved (ready to execute), executed, rejected or cancelled:

```sh
npx @vigil-sol/cli watch <multisig>                                   # every 60 s (--interval, minimum 15)
npx @vigil-sol/cli watch <multisig> --once --state-file ./state.json  # one cycle, for cron / CI
```

- **Alerts** carry the verdict, the multisig, the proposal index, up to three top findings, what the proposal does and, if `VIGIL_WEB_URL` is set, a link to the report in the web app. New proposals and proposals that become approved are analysed at that moment; approval alerts also say when a time lock ends. They never contain an RPC URL, only its host. On-chain text is sanitized.
- **Where alerts go** is set by environment variables only (the webhook URL and the bot token are secrets and are never printed): `VIGIL_DISCORD_WEBHOOK`; `VIGIL_TELEGRAM_BOT_TOKEN` + `VIGIL_TELEGRAM_CHAT_ID` (plain text, no formatting mode). Standard output always gets every alert: one readable line each, or one JSON object per line with `--json`. Logs go to standard error.
- **Exactly once.** The state (`$XDG_STATE_HOME/vigil/<multisig>.json`, default `~/.local/state/vigil/`) is written before any alert is sent and after each delivery. A failed send is retried with backoff; if it still fails, the alert stays queued for that channel only and is retried on later cycles for 24 hours, then dropped with an error in the log. Only a crash between a delivery and the next write can repeat that one alert. Run one watcher per state file.
- **First run.** With no state yet, it alerts on the proposals already pending among the latest 20 transactions, so a proposal opened before you started watching is not missed.
- **Exit codes of `--once`:** 0 when the multisig was read and every alert delivered; 3 otherwise (the state is saved either way).

### Watching with GitHub Actions

[`examples/github-actions/vigil-watch.yml`](examples/github-actions/vigil-watch.yml) runs `vigil watch --once` every 10 minutes and keeps the state in the Actions cache (a new key per run, restored by prefix; saved even when the run fails, so undelivered alerts are retried and delivered ones are not repeated). Secrets go in GitHub Secrets; every action is pinned by commit SHA.

> **`X.Y.Z` in that file is a placeholder.** `@vigil-sol/cli` is not published yet: replace it with a published version (an exact version, not a range) before using the workflow.

Before relying on it, know GitHub's limits ([events that trigger workflows → schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)):

- **Scheduled runs can start late**: GitHub documents that the `schedule` event can be delayed under high load (naming the start of every hour; the example avoids minute 0) without giving a bound, so expect delays of several minutes. An alert can therefore arrive well after the proposal was created. For timely alerts, run `vigil watch` as a long-running process on a machine you control.
- **In a public repository, scheduled workflows are disabled automatically after 60 days without repository activity.** The watcher then stops silently; re-enable it from the Actions tab, or keep the repository active.
- Scheduled workflows run on the default branch only, and a cache not used for 7 days is evicted (the state is then lost, and the next run behaves like a first run: it alerts again on proposals still pending).

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
