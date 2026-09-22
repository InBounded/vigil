# Threat model

Vigil reads and presents hostile, attacker-influenced data (arbitrary transaction bytes, on-chain strings, third-party IDLs) to people making custody decisions. This document lists the threats considered from the start of the project and how each is mitigated. It will be revisited and expanded as later phases add capabilities (simulation, external lookups, the web UI).

Terms `onchain`, `idl-declared`, `external-api`, `simulation`, `rule-inference` refer to the `Provenance` values defined in `packages/core/src/report.ts` (see `AGENTS.md`).

## T1 — Malicious proposal disguised as harmless

An attacker crafts a proposal whose instructions do something different from what a casual read of the target program/label would suggest (e.g. a "swap" that actually reassigns account ownership).

**Mitigation:** every instruction is decoded faithfully from its raw bytes and accounts (never inferred from a name or label alone), cross-checked with deterministic risk rules, and — where available — with `simulateTransaction` results. Nothing is summarized in a way that hides an account, amount, or authority change.

## T2 — Vigil's own website is compromised

The web app's hosting, build pipeline, or CDN is compromised to serve a modified build that misrepresents a proposal (the same failure mode as the 2025 Safe{Wallet} interface compromise Vigil exists to guard against).

**Mitigation:** reproducible builds, a published provenance attestation for each release, and support for running the analysis fully offline (a locally built artifact with a hash the user can verify, or the CLI, which requires no web app at all).

## T3 — A compromised dependency

A transitive or direct npm dependency is compromised (malicious publish, account takeover) and ships malicious code.

**Mitigation:** dependency count is kept minimal, versions are pinned exactly (no `^`/`~`), the lockfile is committed and installs use `--frozen-lockfile`, npm install scripts are blocked by default (pnpm 10 default behavior), and dependency updates are reviewed rather than auto-merged (see `.github/dependabot.yml`).

## T4 — A malicious or compromised RPC endpoint returns fake data

A user-configured RPC endpoint (or a man-in-the-middle) returns fabricated account data to make a dangerous proposal look safe.

**Mitigation:** support for an optional cross-check against a second, independently configured RPC endpoint, with any mismatch surfaced as a finding rather than silently resolved. Planned for the phase that implements the RPC layer.

## T5 — A misleading or incomplete on-chain IDL

A program author publishes an IDL that doesn't match the program's actual on-chain behavior, or omits information to obscure it.

**Mitigation:** everything sourced from an IDL is explicitly labeled `idl-declared` in the report (not `onchain`), with UI copy that states this is author-declared and not proof of behavior. Cross-checked against program verification status (source-to-bytecode attestation) where available.

## T6 — Spoofed token metadata

An attacker creates a token whose name/symbol impersonates a well-known asset (e.g. a fake "USDC").

**Mitigation:** a curated token registry for well-known assets; the mint address is always shown in full regardless of the display name; an impersonation warning is raised when a token's declared symbol/name matches a registry entry but its mint does not.

## T7 — Address poisoning

An attacker gets a lookalike address (matching the first/last characters of a legitimate one) into a transaction, hoping a signer eyeballs only the prefix/suffix.

**Mitigation:** full addresses are always shown, never truncated in a way that hides the difference; a detection rule flags accounts whose address closely resembles (but does not equal) an address elsewhere in the signer's context (e.g. a known vault or a previously used destination).

## T8 — Injection via on-chain strings

Token names, symbols, memos, and IDL text are attacker-controlled and could contain script payloads, control characters, or bidi/zero-width characters designed to visually spoof text.

**Mitigation:** a mandatory sanitizer (per the rules in `docs/reference.md` §11) runs on every on-chain string before it reaches any interface. Sanitized text is always rendered as text, never as HTML. This is enforced by a test asserting no on-chain string can reach a UI without passing through the sanitizer.

## T9 — Incomplete analysis mistaken for a clean bill of health

An RPC error, simulation failure, or undecodable instruction causes part of the analysis to be skipped, but the report still reads as "nothing found."

**Mitigation:** the report's `completeness` field and `incomplete` verdict make gaps explicit; the word "safe" is never used anywhere in either interface. The `no-findings` verdict is rendered as "No findings from the checks performed," never as "safe."

## T10 — State changes between analysis and execution (TOCTOU)

A proposal is analyzed as safe, but before it executes, relevant on-chain state changes — most importantly, a program in the transaction gets upgraded by its (possibly third-party) upgrade authority, changing its behavior.

**Mitigation:** any program invoked by the transaction that has a non-immutable upgrade authority is flagged explicitly. The report shows the slot and wall-clock time the analysis was performed at, and both interfaces offer a clear "re-analyze" action before a signer votes or executes.
