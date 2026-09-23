# Architecture (skeleton)

This document is a skeleton, filled in as each phase lands. It records what's actually built, not the full end-state design already specified in `AGENTS.md` and `docs/reference.md`.

## Layers

```
apps/web        ──┐
apps/cli (bin)  ──┼──>  packages/core  ──>  packages/core/report.ts (AnalysisReport — decoding types only so far)
apps/rpc-proxy  ──┘         │
                             ├── rpc/        (RpcClient, injected — built: KitRpcClient + FixtureRpcClient)
                             ├── squads/     (MultisigAdapter, Squads v4 — built: SquadsV4Adapter)
                             ├── decoders/   (native + Squads + raw transactions — built in Phase 3A; IDL-driven: not yet)
                             ├── rules/      (risk rules — built in Phase 4)
                             └── sanitize/   (on-chain string sanitizer — not built yet)
```

- **`packages/core`** is the isomorphic analysis engine. It performs no I/O directly: all reads go through injected `RpcClient`, `HttpClient`, and `Clock` interfaces (see `AGENTS.md` → Coding standards), which is what makes it runnable in both the browser and Node, and testable offline against fixtures.
- **`packages/cli`** and **`apps/web`** are presentation layers only. They call `@vigil/core` and render its `AnalysisReport`; they do not contain decoding or risk logic themselves.
- **`apps/rpc-proxy`** is an optional Cloudflare Workers component that forwards only allowlisted RPC methods (see `docs/reference.md` §4). Nothing depends on it existing — both the web app and the CLI can talk to any RPC endpoint directly.

## Data flow (target, once later phases land)

1. Input: a Squads v4 multisig address + proposal index, or a raw base64 transaction.
2. `packages/core` reads the minimum on-chain state needed (via the injected `RpcClient`), decodes every instruction, and runs deterministic risk rules over the result.
3. Every fact in the resulting `AnalysisReport` carries an explicit `Provenance` tag.
4. The CLI and web app render the same `AnalysisReport` — they never compute risk themselves, only display it.

## Status by phase

- **Phase 1:** repository skeleton, tooling, CI/CD, documentation. No Solana logic yet.
- **Phase 2:**
  - `packages/core/src/rpc/`: `RpcClient` interface restricted to the allowlisted methods in `docs/reference.md` §4 (enforced by a test that scans `kit-client.ts`'s source, not just exercises it at runtime); `KitRpcClient` (live, via `@solana/kit`) with batching (`getMultipleAccounts` in chunks of 100), bounded concurrency, per-request timeout, 429/5xx-only retry with backoff + jitter honoring `Retry-After`, and `redactRpcUrl`; `FixtureRpcClient` plus `scripts/capture-fixture.ts` for offline, deterministic tests against real captured mainnet data (`fixtures/`).
  - `packages/core/idl/squads_multisig_program.json`: the official Squads v4 IDL, pinned to a commit, hash recorded in `docs/DECISIONS.md`.
  - `packages/core/src/squads/generated/`: the Codama-generated client from that IDL (`scripts/generate-squads-client.ts`, re-run and reviewed as a diff whenever the IDL updates).
  - `packages/core/src/squads/pda.ts`: our own PDA helpers, cross-checked against `@sqds/multisig`'s real functions in every test, including near-`u64::MAX` indices.
  - `packages/core/src/squads/adapter.ts`: `MultisigAdapter` / `SquadsV4Adapter` — `fetchMultisig` (with the `NotASquadsMultisigError` guard), `listProposals` (index walk-down, no `getProgramAccounts`), `fetchProposalBundle` (transaction + proposal + batch sub-transactions).
  - Not yet built: instruction/config-action decoding (only transaction *type* is identified by discriminator so far, not contents), risk rules, the sanitizer, `report.ts`, and both UIs.
- **Phase 3A (native decoding):**
  - `packages/core/src/report.ts`: `Provenance`, `DecodedInstruction` (plus an `inner` list for nested instructions), `DecodedAccount`, `AnalysisGap`. The rest of `AnalysisReport` is a later phase.
  - `packages/core/src/decoders/native/`: System, Compute Budget, SPL Token (incl. `Batch`), Associated Token Account, Address Lookup Table, Stake, BPF Upgradeable Loader via the official `@solana-program/*` clients; Memo (strict UTF-8, all three program addresses); Token-2022 hand-written (see `docs/DECISIONS.md`).
  - `packages/core/src/decoders/squads.ts`: Squads v4 instructions via the generated client; the transaction message inside `vaultTransactionCreate`/`batchAddTransaction` is decoded recursively (`message.ts` parses the compact format).
  - `packages/core/src/decoders/decode.ts`: the pipeline. Pure decoding over a shared account-index model (static → lookup writable → lookup readonly); lookup tables fetched in rounds via `getMultipleAccounts` (`lookup-tables.ts`); every undecodable or unresolvable thing becomes an `AnalysisGap`, never a silent omission.
  - Entry points: `decodeRawTransaction` (base64 legacy/v0 wire transaction; v1 rejected for now) and `decodeVaultTransactionMessage` (a Squads proposal's stored message).
  - Not yet built: v1 transactions, IDL-driven decoders, config-action summaries, risk rules, the sanitizer, the full report, both UIs.
- **Phase 3B:** IDL decoding, registry and labels, sanitizer, plain-language summaries (see `docs/DECISIONS.md`).
- **Phase 4 (risk rules):**
  - `packages/core/src/rules/`: 27 pure, deterministic rules (`RULES`) over a `RuleContext` built by `createRuleContext` (partial report, multisig, proposal, options, known addresses, facts gathered beforehand); `runRules` orders the findings (VGL-W011 first) and `computeVerdict` applies the verdict rule. Rule metadata generates `docs/rules.md` (`pnpm docs:rules`).
  - `packages/core/src/report.ts`: `Finding`, `Severity`, `Verdict`, and the rule inputs Phase 5 fills (`ProgramInfo`, `SimulationResult`, `ConfigAction`).
  - `packages/core/src/i18n/render.ts`: `renderFinding` (en, pt-PT).
  - Not yet built: gathering the facts the rules read (balances, history, program/buffer accounts, verification, simulation), report assembly, both UIs.
- **Phase 5+:** to be documented here as they land.

## Central contract

The `AnalysisReport` type (and its sub-types `DecodedInstruction`, `Finding`, `Severity`, `Provenance`, `Verdict`) is defined in full in `AGENTS.md` under "Central contract: AnalysisReport" and will live at `packages/core/src/report.ts` once written. This document does not repeat that definition — treat `AGENTS.md` as the source of truth for it and record any deviation here and in `docs/DECISIONS.md` when it's actually implemented.
