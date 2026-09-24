# Threat model

Vigil reads and presents hostile, attacker-influenced data (arbitrary transaction bytes, on-chain strings, third-party IDLs) to people making custody decisions. This document lists the threats considered from the start of the project and how each is mitigated. It will be revisited and expanded as later phases add capabilities (simulation, external lookups, the web UI).

Terms `onchain`, `idl-declared`, `external-api`, `simulation`, `rule-inference` refer to the `Provenance` values defined in `packages/core/src/report.ts` (see `AGENTS.md`).

## T1 — Malicious proposal disguised as harmless

An attacker crafts a proposal whose instructions do something different from what a casual read of the target program/label would suggest (e.g. a "swap" that actually reassigns account ownership).

**Mitigation:** every instruction is decoded faithfully from its raw bytes and accounts (never inferred from a name or label alone), cross-checked with deterministic risk rules, and — where available — with `simulateTransaction` results. Nothing is summarized in a way that hides an account, amount, or authority change.

## T2 — Vigil's own website is compromised

The web app's hosting, build pipeline, or CDN is compromised to serve a modified build that misrepresents a proposal (the same failure mode as the 2025 Safe{Wallet} interface compromise Vigil exists to guard against).

**Mitigation:** reproducible builds, a published provenance attestation for each release, and support for running the analysis fully offline (a locally built artifact with a hash the user can verify, or the CLI, which requires no web app at all).

**Status (Phase 7):** the offline single-file build exists, with its SHA-256 published next to it; its `<meta>` CSP allows only its own inline script and style by hash, so a modified file does not run (checked in Chromium). The About page explains how to check a build and points to the CLI. The page loads nothing from third parties (no CDN, fonts or analytics; a test checks the built output). Reproducible builds and provenance attestations for the web app are still to come with the release phase.

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

## T11 — Alerts as an attack channel (`vigil watch`)

Alerts carry text derived from on-chain data into chat tools that render Markdown, links and mentions, and the watcher holds secrets (webhook URL, bot token, RPC key).

**Mitigations:**
- **Formatting injection.** Discord: everything that can hold on-chain text sits inside a code block (no Markdown, no masked links, no mentions), backticks are replaced so the block cannot be closed early, and `allowed_mentions: { parse: [] }` suppresses every mention (`@everyone` in a token name pings nobody). Telegram: plain text, no `parse_mode`, link previews off. Every alert text also passes the CLI's `terminalSafe` second barrier (control, bidi, zero-width, tag characters removed).
- **Secrets.** Notifier secrets come from environment variables only, are validated without being echoed, are added to the output redactor, and never reach the state file; the RPC appears by host only. Requests use no redirects (a redirect could carry the payload elsewhere).
- **Missed or repeated alerts.** The state is written before sending and after each delivery; failures are kept per channel and retried; a state file of another multisig or network is refused. An attacker who can make the RPC lie can hide a proposal from the watcher (as from any analysis, T4): use a trusted RPC.
- **Network destinations.** The watcher contacts only the RPC, the verification API (unless `--no-external`) and the channels the user configured. There is no telemetry.

## T-web — Attacks on the web page itself

- **Hostile strings turned into markup or code.** On-chain text is rendered by React as text only; `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function` and similar are banned by Biome rules and by a source test. A second barrier (`safeText`) strips control, bidi, zero-width and tag characters from every report text, including text core passes through unchanged (simulation logs). A test renders a real analysis of a transaction whose memo carries HTML, a script tag, a `javascript:` link and invisible characters.
- **Injected or third-party scripts.** CSP `script-src 'self'` (hashes in the offline file), `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`; no third-party resources at all.
- **Clickjacking.** `frame-ancestors 'none'` and `X-Frame-Options: DENY` on the hosted build. **Not possible on the GitHub Pages mirror** (no custom headers; `frame-ancestors` is ignored in `<meta>`), which the README says.
- **API keys in RPC endpoint URLs.** Stored only in the browser, shown nowhere (reports show the host only; error messages never include transport text). Not stored at all by the offline file, whose storage other local files can read.
- **Look-alike addresses.** Addresses are always shown in full, in groups of four; an address flagged as possible address poisoning (VGL-C008) is highlighted wherever it appears, with the characters that differ from the address it imitates marked.

