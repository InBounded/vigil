# Architecture (skeleton)

This document is a skeleton, filled in as each phase lands. It records what's actually built, not the full end-state design already specified in `AGENTS.md` and `docs/reference.md`.

## Layers

```
apps/web        ──┐
apps/cli (bin)  ──┼──>  packages/core  ──>  packages/core/report.ts (AnalysisReport)
apps/rpc-proxy  ──┘         │
                             ├── rpc/        (RpcClient, injected — not built yet)
                             ├── squads/     (MultisigAdapter, Squads v4 — not built yet)
                             ├── decoders/   (native + IDL-driven — not built yet)
                             ├── rules/      (risk findings — not built yet)
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

- **Phase 1 (this phase):** repository skeleton, tooling, CI/CD, documentation. No Solana logic exists yet; `packages/core/src/index.ts` is an empty module.
- **Phase 2+:** to be documented here as they land — RPC layer, Squads v4 reading, decoders, rules, sanitizer, UIs.

## Central contract

The `AnalysisReport` type (and its sub-types `DecodedInstruction`, `Finding`, `Severity`, `Provenance`, `Verdict`) is defined in full in `AGENTS.md` under "Central contract: AnalysisReport" and will live at `packages/core/src/report.ts` once written. This document does not repeat that definition — treat `AGENTS.md` as the source of truth for it and record any deviation here and in `docs/DECISIONS.md` when it's actually implemented.
