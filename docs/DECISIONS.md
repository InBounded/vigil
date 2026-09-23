# Decisions

Format: date, decision, rationale, and where it was confirmed. Append, don't rewrite history — if a decision changes later, add a new entry that supersedes the old one rather than editing it away.

## 2026-09-22 — Phase 1 tooling versions

All versions below are exact pins (no `^`/`~`), confirmed live against the official source on 2026-09-22, not recalled from memory:

| Tool | Version | Confirmed against |
|---|---|---|
| Node.js | 22.23.2 (pinned in `.nvmrc`) | `nodejs.org/en/download`, current 22.x LTS release line |
| pnpm | 12.5.1 (`packageManager` field) | Already installed in the dev environment (`pnpm --version`) |
| TypeScript | 7.0.2 | `registry.npmjs.org/typescript/latest` |
| Vitest | 5.0.1 | `registry.npmjs.org/vitest/latest` |
| @vitest/coverage-v8 | 5.0.1 | `registry.npmjs.org/@vitest/coverage-v8/latest` (matches vitest version) |
| @biomejs/biome | 2.5.14 | `registry.npmjs.org/@biomejs/biome/latest` |
| @types/node | 22.20.4 | `registry.npmjs.org/@types/node`, latest version in the `22.x` line (matching the pinned Node major, not the registry's overall `latest` dist-tag which tracks a newer Node major) |

`engines.node` in the root `package.json` uses a `>=` floor (`22.20.0`), not an exact pin — this is normal `engines` semantics (an advisory compatibility floor, not a resolvable dependency), distinct from the "no `^`/`~`" rule, which is about dependency version resolution.

`biome.json` was generated with `npx @biomejs/biome@2.5.14 init` to get the real current config schema rather than hand-writing one from memory, then adapted: `vcs.enabled`/`useIgnoreFile` turned on (this is a git repo), `noExplicitAny` and `noNonNullAssertion` set to `error` per `AGENTS.md`'s ban on `any`, double quotes and 2-space indent chosen as a plain default (no prior convention existed to match).

## 2026-09-22 — GitHub Actions pinned by commit SHA

Every action is pinned to the full commit SHA of its latest tagged release as of 2026-09-22, confirmed via the GitHub REST API (`api.github.com/repos/<owner>/<repo>/tags`), not guessed:

| Action | Tag | SHA |
|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| `pnpm/action-setup` | v6.1.0 | `ea17c68df8912ef543352723c149a84f56e3d413` |
| `github/codeql-action/*` | v4.38.1 | `1c5b675653bb5c22dbe9b12b556ec555138e09fd` |
| `ossf/scorecard-action` | v2.4.4 | `2d1146689b8cda280b9bc96326124645441f03bc` |
| `actions/upload-artifact` | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |

The `codeql.yml` workflow's structure (permissions block, `languages: javascript-typescript`, `build-mode: none` for an interpreted language) was taken from GitHub's own current starter workflow (`raw.githubusercontent.com/actions/starter-workflows/main/code-scanning/codeql.yml`), not invented. The `scorecard.yml` workflow was taken from the OSSF Scorecard project's own workflow (`raw.githubusercontent.com/ossf/scorecard/main/.github/workflows/scorecard-analysis.yml`), which was already SHA-pinned and matched the SHAs independently confirmed above (except its `codeql-action/upload-sarif` pin, which was one release older — updated here to the same `v4.38.1` used elsewhere for consistency).

**Open item for the maintainer:** `scorecard.yml` sets `publish_results: true`, which publishes scan results to the public OpenSSF dataset. This is standard for public OSS repos but is an external data disclosure, so it's called out again in `docs/maintainers.md` rather than decided unilaterally — set to `false` there if that's not wanted yet.

## 2026-09-22 — Apache-2.0 license text

`LICENSE` is the verbatim text from `https://www.apache.org/licenses/LICENSE-2.0.txt`, downloaded directly (not paraphrased by a model) and diffed by line count (202 lines) against the known canonical length. The appendix copyright line was filled in as "Copyright 2026 Vigil Contributors" — a placeholder generic attribution; change it if a different legal name/entity should hold copyright.

## 2026-09-22 — Monorepo layout and scripts

Workspace layout, strict `tsconfig` flags, Biome, and Vitest were mandated directly by `AGENTS.md`, so no alternative was evaluated. Implementation choices made while wiring them up:

- `pnpm typecheck` recurses (`pnpm -r run typecheck`) rather than using TypeScript project references / `tsc -b`, to avoid the added complexity of `composite` project graphs for four still-empty packages. Revisit if build times become a problem.
- Vitest's monorepo `projects` field (`["packages/*", "apps/*"]`) is used instead of the deprecated `vitest.workspace.ts`, confirmed current as of Vitest 5 via `vitest.dev/guide/workspace`.
- No runtime dependencies exist yet anywhere in the workspace, satisfying the Phase 1 acceptance criterion; all five pinned packages above are `devDependencies` only.
- Each package's `tsconfig.json` excludes `src/**/*.test.ts` from the build. Without this, `tsc` compiled `*.test.ts` into `dist/`, which both shipped test code in build output and caused Vitest to pick up the compiled `dist/*.test.js` files as additional test files on a second run (test count doubled from 4 to 8). Caught by actually re-running `pnpm check` twice in a row rather than trusting the first green run.

## 2026-09-22 — @types/node major-version updates ignored in Dependabot

`.github/dependabot.yml`'s `npm` update group now ignores `semver-major` updates for `@types/node`. The pinned `22.20.4` tracks Node 22 (see `.nvmrc`); Dependabot's default `latest` resolution for `@types/node` follows whatever Node major is newest on npm (currently 26.x), which would otherwise propose upgrades to a types package that no longer matches the runtime this project targets.

## 2026-09-22 — Phase 2 package versions

All confirmed live against the npm registry (`registry.npmjs.org/<pkg>/latest`) on 2026-09-22, not recalled from memory:

| Package | Version | Where used |
|---|---|---|
| `@solana/kit` | 8.3.0 | `@vigil/core` runtime dependency — first runtime dep this project has (everything in Phase 1 was devDependencies only). Confirmed real API: `createSolanaRpc(url, config)`, builder+`.send()` pattern, default commitment `"confirmed"`, `Slot`/`Lamports` are branded `bigint` types (matches the "amounts are always bigint" rule natively, no wrapping needed). |
| `@sqds/multisig` | 2.1.4 | `@vigil/core` devDependency, cross-checking our own PDA helpers only (depends on `@solana/web3.js` v1, which is why it's dev-only per `AGENTS.md`). Confirmed real PDA helper names/signatures (`getMultisigPda`, `getVaultPda`, `getTransactionPda`, `getProposalPda`, `getEphemeralSignerPda`, `getBatchTransactionPda`, `getSpendingLimitPda`, `getProgramConfigPda`) by reading its shipped `.d.ts` files directly, not guessing. |
| `codama` | 1.11.0 | root devDependency, code generation only |
| `@codama/nodes-from-anchor` | 1.5.6 | root devDependency. Confirmed real API: `rootNodeFromAnchor(idl)` — a single function that auto-detects legacy (pre-0.30, our IDL's format) vs. new Anchor IDL format via a union type, so no separate legacy-handling code was needed. |
| `@codama/renderers-js` | 2.5.0 | root devDependency. Confirmed real API: default export `renderVisitor(outputDir)`, used via `codama.accept(renderVisitor(outDir))` where `codama = createFromRoot(rootNodeFromAnchor(idl))`. |
| `tsx` | 4.23.15 | root devDependency, used to run `scripts/*.ts` directly (`pnpm exec tsx scripts/foo.ts`) rather than requiring `node --experimental-strip-types` (which Node 22 supports but only as an experimental flag) or a manual build step. |

**pnpm install script approvals** (`pnpm-workspace.yaml`'s `allowBuilds`), decided per-package by reading each flagged package's actual `scripts` field in `node_modules/.pnpm` rather than blanket-approving or blanket-denying:
- `esbuild`: **allowed**. Its `postinstall` (`node install.js`) only selects/fetches its own matching prebuilt binary — required for esbuild, and therefore `tsx` (which bundles it), to run at all.
- `bigint-buffer`, `bufferutil`, `utf-8-validate`: **denied**. All three are optional native-binding accelerators (`node-gyp-build`/`node-gyp rebuild`) with documented pure-JS fallback paths when not built (`bigint-buffer`'s own install script says so explicitly: `"Couldn't build bindings. Non-native version used."`). Denying them avoids running arbitrary native builds for a performance optimization we don't need yet.

## 2026-09-22 — Squads v4 IDL provenance

`packages/core/idl/squads_multisig_program.json` was fetched from `squads-protocol/v4` at commit `af94153ff77a28b6effe46b9c94baaa93742b48c` (the `main` branch's HEAD as of 2026-09-22), path `sdk/multisig/idl/squads_multisig_program.json`.

- SHA-256 of the file as committed: `cb9a0a29040ec3853a5105c547ffc608bb0e3175d78dacf30d463aff939f9b9b`.
- `metadata.address` inside the IDL is `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` — confirmed to match `docs/reference.md`'s Squads v4 program address exactly, so the phase's "stop and ask if it doesn't match" condition did not trigger.
- `metadata.binaryVersion` is `0.29.0`, i.e. this is a **legacy-format** Anchor IDL (pre-0.30). Instruction discriminators are therefore not embedded in the IDL and were computed as the first 8 bytes of `sha256("global:<snake_case_instruction_name>")`, per `docs/reference.md` §10 and cross-verified against real on-chain instruction data (see the fixture-hunting decision below) before being relied on anywhere in code.

## 2026-09-22 — Fixture selection from live mainnet data

Found by walking `getSignaturesForAddress` on the Squads v4 program (public mainnet RPC, `api.mainnet-beta.solana.com`, 1.5s spacing between calls, ~155 signatures across 3 pages, ~155 `getTransaction` calls plus a handful of `getMultipleAccounts` calls — all allowlisted methods, no `getProgramAccounts`), classifying each Squads instruction by its computed discriminator, then decoding candidate `Multisig` accounts' raw Borsh bytes directly (not via a library, since the generated client didn't exist yet at exploration time) to get real member/permission/threshold data:

- **Multisig summary + VaultTransaction fixture**: `3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt` — 12 members, threshold 1, genuinely mixed permissions (7× `Initiate+Vote+Execute`, 5× `Initiate`-only). Its most recent transaction, index `352`, is a `VaultTransaction`; the transaction PDA (`MwXvLTjbQFFy5fMt5q9cU9HC92huDiriAk6KQUS6VLG`) and proposal PDA (`5Y3bXvwEj3pSWDJV3LzDJNKEFcyeMBZe16ijD53RkSE7`) were derived independently (via `@solana/web3.js`'s `findProgramAddressSync`, temporarily installed standalone for this verification step only, not added to the project) and matched the addresses actually used on-chain in its create/approve/execute lifecycle (slots 449358619 → 449358674 → 449358706).
- **ConfigTransaction fixtures**: `4AUG3JkY43g39avoD5e66BVKCj5RDZRGQoKgGyNcDJnx` (index 1) and `EjtH4Doy78jjRKVCCr35XXVDrG8jdGdivj3f5wAJECQ7` (index 1, backup/second example). **Both are historical-only, not live-account fixtures.** Every `ConfigTransaction` observed across all ~155 sampled signatures (4 total) was created, approved twice, executed, and closed (`configTransactionAccountsClose` reclaims both the `transaction` and `proposal` accounts) **within a single atomic transaction** — an automated pattern, not organic usage, that never leaves the account independently queryable via `getAccountInfo` at any point (it exists only transiently mid-transaction). No organically-created, still-open `ConfigTransaction` turned up in the sampled window. Given that, these two fixtures capture the **full historical `getTransaction` record** of the creating transaction (signatures `2HU86rfvwQUVoHtBVD2APHY9uEWk5RCw4tceTM8h2NHUzVxm6YAMQSLa5tTd4AWJjgNnUy1f79ndPGZzucQt3Zz1` and `3w38dUfnzfheZaxPwjBmqcABue8RBvNx1EthKS55u8JXZXxzMcAqnbZ5zbiQNBeQkGtefYsqdhDj1fwPzG6RBgr1`) rather than an account snapshot — real, immutable, on-chain data either way, just sourced via `getTransaction` instead of `getAccountInfo`/`getMultipleAccounts`, which `scripts/capture-fixture.ts` supports as a second capture mode for exactly this reason.
- **Batch**: none found after sampling ~155 recent Squads v4 program transactions specifically for `batchCreate`/`batchAddTransaction`/`batchExecuteTransaction`. Per the phase's own acceptance criteria this is acceptable to omit; add one later if/when a real example is found. No Batch fixture exists in `fixtures/` as of this phase.

All four fixtures were captured with the real `KitRpcClient`/`scripts/capture-fixture.ts` (not raw `curl`), so the capture pipeline itself is exercised the same way it will be used going forward. `packages/core/src/rpc/fixture-file.test.ts` loads all four and asserts basic shape against them.

## 2026-09-22 — Squads v4 client generation (Codama)

`scripts/generate-squads-client.ts` runs `rootNodeFromAnchor` → `createFromRoot` → `codama.accept(renderVisitor(outDir, options))`, writing to `packages/core/src/squads/generated/`.

`renderVisitor`'s defaults scaffold a **standalone package** (its own `package.json`, plus an extra `src/generated/` nesting inside the given output directory) — appropriate for generating a client meant to be published on its own, not for generating code that lives inside an existing package like `@vigil/core`. Options were set to avoid that: `generatedFolder: "."` (write directly into `outDir`, no extra nesting), `syncPackageJson: false` (don't scaffold a `package.json` — `@vigil/core`'s own `package.json` already exists), `deleteFolderBeforeRendering: true` (so re-running the generator after an IDL update cleanly reflects deletions, not just adds/edits), `importExtension: "js"` (required — this project's `tsconfig.base.json` uses `moduleResolution: "NodeNext"`, which needs explicit `.js` extensions on relative imports; the default omits them).

The generated account discriminator for `Multisig` (`[224, 116, 121, 186, 68, 161, 79, 236]`) was cross-checked against an independent computation of `sha256("account:Multisig")[:8]` done during fixture-hunting, before this generator existed — the two agree, which cross-validates both the generator's output and the manual decoding done earlier to find fixture candidates.

**Runtime dependency found missing, not assumed**: the generated code imports from `@solana/program-client-core`, which `renderVisitor` would normally have added to the scaffolded `package.json` it was told not to generate. Running `pnpm --filter @vigil/core run typecheck` surfaced this immediately as `TS2307: Cannot find module`, rather than it being silently missing. Added to `@vigil/core`'s real `dependencies` at `8.3.0`, matching the rest of the `@solana/kit` family and confirmed current via the npm registry.

`biome.json` gained two `overrides` entries rather than editing generated output by hand (which the generated files themselves say not to do, and which `scripts/generate-squads-client.ts` would silently undo on the next run anyway):
- `packages/core/src/squads/generated/**`: turns off `style/noNonNullAssertion` and `complexity/noBannedTypes`, the only two lint rules the generated client's accessor/error-formatting code legitimately trips (confirmed by reading each flagged line, not blanket-suppressed). Formatting and import order are still enforced and were auto-fixed with `biome check --write` right after generation — re-run that after every regeneration.
- `packages/core/idl/**` and `fixtures/**`: formatter turned off entirely. These are captured upstream artifacts (the IDL's `docs/DECISIONS.md`-recorded SHA-256, and fixtures' real on-chain bytes) — reformatting them would risk silently drifting their bytes from what was actually fetched/captured.

## 2026-09-22 — MultisigAdapter / SquadsV4Adapter (`packages/core/src/squads/adapter.ts`)

Implements `MultisigAdapter` per the phase spec: `fetchMultisig` (owner + `Multisig` discriminator check, `NotASquadsMultisigError` otherwise, decoding via the generated `decodeMultisig`), `listProposals` (index walk-down from `transactionIndex`, PDA derivation + a single `getMultipleAccounts` batch call — never `getProgramAccounts` — with per-index type identification by account discriminator), and `fetchProposalBundle` (transaction + proposal + every `VaultBatchTransaction` for a batch).

**A real finding caught by the offline tests, not a hypothetical**: `packages/core/src/squads/adapter.test.ts` originally hardcoded `transactionIndex: 352n` for the `3gjeSq...` multisig, copied from the fixture-hunting notes above. The test failed — the live fixture data (`fixtures/multisig-mixed-permissions.json`, re-verified by decoding its raw bytes directly) now says `353n`. Between capturing `multisig-mixed-permissions.json` and `vault-transaction.json` a few minutes apart, this real, active mainnet multisig had a new transaction created on it, advancing its tip. Both fixtures agree with each other (both say `353`); only the test's hardcoded expectation, written from memory before the values were captured, was wrong. Fixed by reading the fixture's actual bytes instead of trusting the earlier note, and the `listProposals` test now exercises exactly this scenario on purpose: the multisig's live tip (353) has no captured transaction, while index 352 (captured before the tip moved) does — proving the walk-down correctly reports "nothing found" for an index that's missing from the fixture rather than assuming adjacency to the tip.

`SquadsMultisigSummary`/`SquadsProposalBundle`/etc. (`packages/core/src/squads/types.ts`) are new types local to the `squads/` module, not yet the `MultisigSummary`/`ProposalSummary` referenced (but not defined) in `AGENTS.md`'s `AnalysisReport` contract — that contract is assembled in a later phase, once decoders and rules exist too. When that phase builds `packages/core/src/report.ts`, it will likely construct its `MultisigSummary`/`ProposalSummary` from these, not duplicate them; noted here so that phase doesn't have to rediscover this.

## 2026-09-22 — Phase 3A package versions (native instruction decoding)

All confirmed live against `registry.npmjs.org/<pkg>/latest` on 2026-09-22 and pinned exactly. Every `@solana-program/*` client peers on `@solana/kit ^8.3.0`, matching the pinned kit.

| Package | Version | Kind | Purpose | Unpacked size | Confirmed API |
|---|---|---|---|---|---|
| `@solana-program/system` | 0.15.0 | runtime | System Program parsing | 732 KB | `parseSystemInstruction`, `SystemInstruction`, `SYSTEM_PROGRAM_ADDRESS` (read from shipped `.d.ts`) |
| `@solana-program/token` | 0.17.0 | runtime | SPL Token **and** Associated Token Account parsing | 1.9 MB | `parseTokenInstruction`, `parseAssociatedTokenInstruction`, `AuthorityType`, `TOKEN_PROGRAM_ADDRESS`, `ASSOCIATED_TOKEN_PROGRAM_ADDRESS` |
| `@solana-program/compute-budget` | 0.19.0 | runtime | Compute Budget parsing | 271 KB | `parseComputeBudgetInstruction` |
| `@solana-program/address-lookup-table` | 0.15.0 | runtime | ALT instruction parsing **and** ALT account decoding for resolution | 346 KB | `parseAddressLookupTableInstruction`, `getAddressLookupTableDecoder` (layout checked against its source: u32 state, u64, u64, u8, `Option<Address>` with zeroes-as-none, u16 padding, addresses to the end = 56-byte header) |
| `@solana-program/memo` | 0.15.0 | runtime | Memo program addresses only (`SUPPORTED_MEMO_PROGRAM_ADDRESSES`); decoding is ours (strict UTF-8) | 54 KB | constants read from shipped `.d.ts` |
| `@solana-program/stake` | 0.10.0 | runtime | Stake parsing | 978 KB | `parseStakeInstruction` |
| `@solana-program/loader-v3` | 0.7.0 | runtime | BPF Upgradeable Loader parsing | 448 KB | `parseLoaderV3Instruction` (tags 0–7) |
| `@solana-program/token-2022` | 0.19.0 | **dev only** | Cross-checking our hand-written Token-2022 decoder in tests | 7.9 MB | `parseToken2022Instruction`, every `get*Instruction` builder used in `token-2022.test.ts` |
| `fast-check` | 4.10.2 | dev only | Fuzzing decoders with arbitrary bytes, as `AGENTS.md` prescribes | 1.5 MB | `fc.assert`, `fc.property`, `fc.uint8Array`, `fc.record`, `fc.constantFrom` |

Alternatives considered for the runtime clients: hand-writing every native decoder. Rejected — `AGENTS.md` prefers the official `@solana-program/*` clients "where they exist and provide parsing", and they are Codama-generated from each program's own IDL by the program maintainers (Anza / Solana Foundation org `solana-program`), actively released in lockstep with kit. All are ESM, tree-shakable, zero runtime dependencies beyond kit (except `token`, which depends on `@solana-program/system`, already listed). None has an install script.

No `Vote` program decoder: out of scope for this phase (agreed with the maintainer). Vote instructions surface as `decoder: "none"` plus an `UNKNOWN_PROGRAM` gap.

## 2026-09-22 — Token-2022 decoder is hand-written (maintainer decision), with a corrected size rationale

Decision (maintainer, 2026-09-22): hand-write the Token-2022 decoder, fully decoding every instruction that sets or changes an authority, including extension instructions; keep `@solana-program/token-2022` as a dev dependency for cross-checking only.

**Correction to the rationale given when proposing this.** The plan said the official client would "load ZK crypto into the browser". Measured with esbuild (`--bundle --minify --format=esm --platform=browser`, the same esbuild `tsx` ships), that is not true for parsing — tree-shaking drops the confidential-transfer code:

| Bundle | Minified | gzip -9 |
|---|---|---|
| kit baseline (`getAddressDecoder` only) | 35.2 KB | 11.2 KB |
| `parseToken2022Instruction` from `@solana-program/token-2022@0.19.0` | 96.3 KB | 19.3 KB |
| our `token2022Decoder` | 43.8 KB | 13.7 KB |

So the official parser costs ~61 KB minified / ~8 KB gzip over the kit baseline versus ~8.5 KB / ~2.5 KB for ours. The remaining reasons to hand-write are therefore (a) that size difference, and (b) keeping the production dependency tree small: the official package brings runtime dependencies on `@noble/curves`, `@solana-program/record` and `@solana-program/zk-elgamal-proof`, plus a peer dependency on `@solana/zk-sdk`, none of which a read-only parser needs. The trade-off accepted: we own ~350 lines of layout code. It is mitigated by `token-2022.test.ts`, which builds 75 instructions with the official client's own builders and asserts our name, arguments and account roles equal the official parser's, for every instruction we fully decode (including `SetAuthority` for all 18 authority types, set and removed).

Scope of full decoding: base instructions (0–20 except 21, plus 22, 25, 35, 38), `SetAuthority` for all 18 `AuthorityType`s, `Initialize*`/`Update*` for TransferHook (36), MetadataPointer (39), GroupPointer (40), GroupMemberPointer (41), Pausable (44: initialize/pause/resume), Token Metadata `UpdateAuthority` and Token Group `UpdateGroupAuthority` (8-byte interface discriminators, checked three ways: program source, official client constants, and our own `sha256("<namespace>:<name>")[..8]`), and `Batch` (255, recursively). Every other extension sub-instruction is identified by name only and reported with an `INSTRUCTION_ARGS_NOT_DECODED` gap, so it never looks fully understood.

Layout sources: `solana-program/token-2022` at commit `f0d526508a9fa7e638b9aca1800d9c504ed87335` — `interface/src/instruction.rs` (`unpack_with_rest`, `AuthorityType::from`, `unpack_pubkey_option` = 1-byte tag + 32 bytes), `interface/src/extension/*/instruction.rs` (`MaybeNull<Address>` = 32 bytes, all-zero = none), `program/src/processor.rs` (`process_batch` item layout; dispatch order: 1-byte tag first, then Token Metadata, then Token Group).

Role names follow the official client where they differ from what we first wrote (caught by the cross-check test): `syncNative` takes an optional `rent` account (confirmed in `process_sync_native`); the TransferHook update and pause/resume authority role is `authority`.

## 2026-09-22 — Discrepancies with `docs/reference.md` found in Phase 3A

- **§7 BPF Upgradeable Loader, tags 8 `Migrate` / 9 `ExtendProgramChecked`**: they do not exist. `anza-xyz/solana-sdk` `loader-v3-interface/src/instruction.rs` (master, 2026-09-22) defines exactly 8 variants (0–7), and Agave master's `programs/bpf_loader/src/lib.rs` handles exactly those 8 (Agave pins `solana-loader-v3-interface = "9.0.0"`). `@solana-program/loader-v3@0.7.0` also has 0–7. No hand-written decoder was added; any other tag surfaces as `UNKNOWN_INSTRUCTION`.
- **§1 Memo**: there are three Memo program addresses, not one. `@solana-program/memo@0.15.0` exports `SUPPORTED_MEMO_PROGRAM_ADDRESSES` = v1 `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`, `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (the one in `reference.md`, which the package calls "v3"/legacy) and the current `Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH`. All three are decoded.
- **§9 Address Lookup Table header**: confirmed 56 bytes. Agave rejects tables whose address section is not a multiple of 32 bytes; we treat such an account as invalid too.
- **Transaction versions**: `v1` transaction messages are live on mainnet (observed 2026-09-22: `getTransaction` with `maxSupportedTransactionVersion: 0` failed with "Transaction version (1) is not supported" for a large share of recent Token-2022 and Memo transactions). `reference.md` does not mention v1. See the Phase 3A raw-mode entry below.

## 2026-09-22 — Phase 3A decoding pipeline design

- **Contract additions** (`packages/core/src/report.ts`): only `Provenance`, `DecodedInstruction`, `DecodedAccount`, `AnalysisGap` exist so far; the rest of `AnalysisReport` is a later phase. Two additions to the `AGENTS.md` contract: `DecodedInstruction.inner?: DecodedInstruction[]` (instructions carried inside another: the message of a Squads `vaultTransactionCreate`/`batchAddTransaction`, or the items of a Token `Batch`), and an `AnalysisGap` shape `{ code, message, instructionIndex?, address? }` with a closed set of codes, since `AGENTS.md` names `AnalysisGap` without defining it.
- **Account index resolution** is shared by Solana wire messages and Squads messages: static keys, then all lookups' writable entries, then all lookups' readonly entries. Confirmed for Squads in `utils/executable_transaction_message.rs` (`get_account_by_index`, squads-protocol/v4 at the pinned commit), and for Solana by comparing against `meta.loadedAddresses` of a real v0 transaction in `squads-fixtures.test.ts`.
- **Squads compact message format** (`parseSquadsTransactionMessage`): from `instructions/vault_transaction_create.rs` and `utils/small_vec.rs` at the pinned commit (`SmallVec<u8, _>` everywhere except instruction data, `SmallVec<u16, u8>`), with the program's own `TryFrom` validation applied. Cross-checked against `@sqds/multisig`'s encoder and its beet deserializer, and against real mainnet data (raw creation transaction vs. the stored `VaultTransaction` it created).
- **Lookup-table resolution** fetches tables with one `getMultipleAccounts` per round. Decoding is pure; a round that meets a table it hasn't fetched yet records it, then the pipeline fetches and re-decodes. Tables can only be discovered one embedding level deeper per round, so rounds are bounded by `MAX_EMBEDDED_DEPTH` (3). A missing, foreign-owned, uninitialized or malformed table, or an index past its end, is a gap; affected instructions are shown as undecoded with no accounts rather than with guessed ones.
- **Instructions whose program address can't be resolved** (only possible inside a Squads message, where program IDs may come from lookup tables) are omitted from `instructions` but recorded as an `ACCOUNT_UNRESOLVED` gap with their top-level index.
- **Summaries** are generic: `ix.<program>.<instruction>` with every scalar argument and every named account role as string params; `null` becomes `"none"` so an authority being removed is explicit. Wording is the UI's job.
- **Strings are not sanitized here.** Memo text and Squads memos are returned raw in `args`; the sanitizer is a later phase and must run before any interface renders them.
- **Transaction buffers**: `transactionBufferCreate`/`Extend` and `vaultTransactionCreateFromBuffer` carry only a chunk (or none) of the message; they are decoded, and an `EMBEDDED_MESSAGE_IN_BUFFER` gap says the proposal content was not shown.

## 2026-09-22 — Raw base64 transaction mode: v1 messages rejected for now

`decodeRawTransaction` accepts legacy and v0 wire transactions (signatures + message, standard base64). `@solana/kit@8.3.0` can decode v1 messages, but they are rejected with a typed `DecodeError("INVALID_TRANSACTION")`: `AGENTS.md` requires every decoder to be tested against real data, and the Phase 2 `KitRpcClient.getTransaction` pins `maxSupportedTransactionVersion: 0`, so no real v1 transaction could be captured. Supporting v1 needs a change to Phase 2 code (the RPC client) and is left to the maintainer's decision; it is listed as an open item in the Phase 3A delivery.

## 2026-09-22 — Stake: legacy account layout handled on top of `@solana-program/stake`

Found by the real-data fixture test, not by reading docs: on mainnet transaction `D78nFyzr…` (legacy-layout `Withdraw`), `@solana-program/stake@0.10.0`'s parser labelled the **Clock sysvar as `withdrawAuthority`** and the StakeHistory sysvar as `lockupAuthority`; `DelegateStake` and `Deactivate` showed the same shift. Cause: the Stake program (solana-program/stake `program/src/processor.rs`, commit `6ff57404c5b723c96bad6c7438d812825968ecaf`) accepts two account layouts for ten instructions — the current, sysvar-free one and the legacy one with sysvars — and tells them apart by checking whether the account at a fixed "branch" position is the Clock sysvar (Rent for `Initialize`/`InitializeChecked`). The client only models the current layout.

`decoders/native/stake.ts` detects the legacy layout exactly as the program does, removes those sysvar positions, lets the official parser name the rest, and re-inserts the sysvars with their own roles (`clockSysvar`, `stakeHistorySysvar`, `stakeConfig`, `rentSysvar`). Covered by tests on three real legacy-layout transactions plus two current-layout instructions built with the official builders. Mislabelling a sysvar as an authority is exactly the kind of error Vigil must not make, so this is recorded as a known limitation of the upstream client (worth reporting upstream; not done from here).

The sysvar addresses are declared locally (kit 8.3.0 does not re-export `@solana/sysvars` from its root) and asserted equal to `@solana/web3.js`'s `SYSVAR_CLOCK_PUBKEY` / `SYSVAR_RENT_PUBKEY` in tests.

## 2026-09-22 — Phase 3A fixtures

Found by walking `getSignaturesForAddress` on the Loader, Squads, Token-2022, Memo, ALT and Stake programs (public mainnet RPC, 1.2–1.5 s spacing, ~1,200 `getTransaction` calls, all allowlisted methods, via the project's own `KitRpcClient`), classifying top-level instructions with the new decoders, then captured with `scripts/capture-fixture.ts`. Each fixture's `description` names every transaction and why it was picked.

- `squads-create-with-lookup-table.json` — v0 Squads create/approve/execute/close; the outer message *and* the embedded Squads message load accounts from table `C4X9vTAX…` (captured).
- `squads-program-upgrade.json` — a real Squads proposal to upgrade program `Sett1ereLzRw7neSzoUSwp6vvstBkEgAgQeP6wFcw5F`: creation transaction, the live `VaultTransaction`, `Proposal` and `Multisig` accounts; plus an unrelated direct top-level loader `Upgrade`.
- `squads-batch-and-token-2022.json` — two `batchAddTransaction` (USDC transfers, mint loaded from table `DZboAojT…`, captured) and a `vaultTransactionCreate` embedding a Token-2022 `MintToChecked`. (Phase 2 found no batch; this phase did.)
- `native-instructions.json` — Stake (legacy layout), Memo, System (incl. durable-nonce advance), ATA, SPL Token, Token-2022, ALT program, and a v0 transaction resolving four lookup tables.

Lookup tables were captured at capture time, after the transactions that used them. This is sound because tables are append-only (existing entries never change) — and it is verified, not assumed: tests assert our resolution equals the cluster's own `meta.loadedAddresses` for both v0 transactions that have it.

**Not found in real data** (covered only by cross-checks against the official client's encoders and the program source): any Token-2022 authority change (`SetAuthority`, extension updates, metadata/group authority), any Token or Token-2022 `Batch`, loader `SetAuthority`/`SetAuthorityChecked`/`Close`/`ExtendProgram`, Stake `Authorize*`/`Merge`/`Split`, and Squads `configTransactionCreate` embedded config actions. Recent Token-2022 activity is largely v1 transactions, which the Phase 2 RPC client cannot fetch (see the raw-mode entry above).

## 2026-09-22 — Evidence for v1 transactions (maintainer challenged the claim)

The maintainer questioned whether a transaction version 1 exists (understanding: only legacy and v0). Evidence gathered on 2026-09-22; the earlier claim stands and is **not** retracted:

- **Official source**: `anza-xyz/solana-sdk` at commit `43339f080f1264e017b0a917dd87dfbe82ca4e95`, `message/src/versions/mod.rs`: `pub enum VersionedMessage { Legacy(LegacyMessage), V0(v0::Message), V1(v1::Message) }`, deserialized when the prefix byte is `0x80 | 1`. `message/src/versions/v1/message.rs` line 1: "Core Message type for V1 transactions (SIMD-0385)"; its doc comment: "A V1 transaction message (SIMD-0385) supporting 4KB transactions with inline compute budget". `@solana/kit@8.3.0` also ships `V1CompiledTransactionMessage`.
- **Real mainnet signature**: `2TYLLmgrBe82yNhbQo2sZRWE3Zp7bAykig4BqW3Ux3LfcosSpFKYHf9Z75m5RcHhCPdGbmkJ7i9ws5M3TfH1Ea9C` (slot 449506996, a Token-2022 transaction). Queried with plain `curl` against `api.mainnet-beta.solana.com`, independent of kit:
  - `getTransaction` with `maxSupportedTransactionVersion: 0` → error `-32015` "Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1".
  - with `maxSupportedTransactionVersion: 1` → `"version": 1`; the wire bytes begin `0x81` (versioned prefix, version 1), and the transaction is 2,310 bytes, above the legacy/v0 1,232-byte limit.

So `maxSupportedTransactionVersion: 0` covers legacy and v0 but **not** v1. The base64-mode error message ("v1 transaction messages are not supported yet") is accurate and unchanged; its source comment now cites SIMD-0385. The discrepancy with `docs/reference.md` (which does not mention v1) stays recorded. Supporting v1 still needs the maintainer's decision, because it requires changing the Phase 2 RPC client.

## 2026-09-22 — Test files are now typechecked by `pnpm check`

Every workspace package's `tsconfig.json` excludes `src/**/*.test.ts` (so tests aren't compiled into `dist/`, see the Phase 1 entry), and Vitest does not typecheck, so type errors in tests went unnoticed. Each package now has a `tsconfig.test.json` (extends `tsconfig.json`, `noEmit`, includes the tests) and its `typecheck` script runs both configs. Verified by adding a deliberately ill-typed test file: `pnpm typecheck` exited 1 naming it; the probe was then deleted.

Turning the gate on surfaced 23 errors in Phase 2 tests (`rpc/fixture-file.test.ts`, `rpc/retry.test.ts`, `squads/adapter.test.ts`, `squads/pda.test.ts`), not only the one file reported in the Phase 3A delivery. All were typing-only: string literals passed where kit's branded `Address`/`Signature` types are required (fixed with kit's `address()`/`signature()`, which also validate the string at runtime), and a DOM-only `HeadersInit` type not in the ES2023 lib (replaced with `ConstructorParameters<typeof Headers>[0]`). No test's assertions or data changed.

## 2026-09-22 — Items not yet tested on real data must be covered by the Phase 10 devnet e2e

No real mainnet example was found for these during Phase 3A; they are covered only by cross-checks against official clients' encoders and the programs' source. **The Phase 10 devnet end-to-end test must create each of them on devnet and assert Vigil decodes it correctly** (name, arguments, account roles), and the result must be recorded here:

- Token-2022: `SetAuthority` (across authority types, both set and remove), the TransferHook / MetadataPointer / GroupPointer / GroupMemberPointer update instructions, Pausable pause/resume, Token Metadata `UpdateAuthority`, Token Group `UpdateGroupAuthority`.
- SPL Token and Token-2022 `Batch` (tag 255), including a batch that contains a `SetAuthority`.
- BPF Upgradeable Loader: `SetAuthority` (including to none), `SetAuthorityChecked`, `Close`, `ExtendProgram`.
- Stake: `Authorize`, `AuthorizeChecked`, `AuthorizeWithSeed`, `AuthorizeCheckedWithSeed`, `Merge` — in both the legacy (sysvar) and current account layouts.

## 2026-09-22 — v1 transactions supported (maintainer decision; supersedes "Raw base64 transaction mode: v1 messages rejected for now")

Maintainer decision: support v1; keep scope to that, no other Phase 2 changes.

- **RPC (`KitRpcClient.getTransaction`, Phase 2 code)**: requests `maxSupportedTransactionVersion: 1` (typed as allowed by `@solana/kit@8.3.0`: `TransactionVersion = 'legacy' | 0 | 1`). If the endpoint answers JSON-RPC `-32602` (invalid params) to that request, the client retries with `0`, uses `0` for the rest of its life, and records an `RPC_TRANSACTION_VERSION_UNSUPPORTED` gap, exposed through a new non-RPC method `RpcClient.limitations()` (`FixtureRpcClient` returns none). Callers must copy those into the report's gaps. Any other error (including `-32015`, a transaction newer than requested) is rethrown unchanged. The allowlist is unaffected: no new RPC method is called.
  - **Uncertain trigger**: current Agave (`rpc/src/rpc.rs` at `25f128d0fcb1735e8b1f31b5f2083fdd28c11df8`) accepts any `u8` version with base64 encoding and only rejects `>= 1` for base58 (`validate_max_supported_transaction_version_for_encoding`); no endpoint that rejects `1` was observed. `-32602` is the standard JSON-RPC code an endpoint would use for an unaccepted parameter value, so it is the trigger; if a real endpoint rejects differently, this must be revisited. Tested against a local fake endpoint (`rpc/transaction-version.test.ts`) for all three paths: supports v1, rejects v1, other error.
- **Base64 mode (`decodeRawTransaction`)**: v1 is now decoded. `@solana/kit@8.3.0`'s decoders read the real mainnet v1 transaction `2TYLLmgr…` byte-exactly (2,310/2,310 transaction bytes, 2,246/2,246 message bytes). v1 has no address lookup tables; instructions come from its `instructionHeaders`/`instructionPayloads`. The inline compute budget is returned as `transactionConfig` (`priorityFeeLamports`, `computeUnitLimit`, `loadedAccountsDataSizeLimit`, `heapSize`), mapped with kit's exported `transactionConfigMaskHas*` predicates in the same order as kit's internal (unexported) `decompileTransactionConfig` and the SDK's `TransactionConfig`. The typed "v1 not supported" error is gone, so no base64-mode limitation remains to document; the README documents the RPC-endpoint limitation instead.
- **Real-data test**: new fixture `fixtures/v1-transaction.json` — successful v1 transaction `3RpFf2ab…` (slot 449509982; inline config: priority fee 1500 lamports, CU limit 420000, loaded-accounts limit 67108864), captured with the updated client. The failed v1 transaction `2TYLLmgr…` cited earlier could not be captured: its `meta.err` contains a bigint (`Custom: 7n` as returned by kit) that `scripts/capture-fixture.ts` cannot JSON-serialize. That is a Phase 2 script bug, left unfixed per the maintainer's "no other Phase 2 changes"; it affects any failed transaction with a custom error code.
- The Phase 3A test asserting that v1 is rejected was replaced by one asserting a kit-built v1 transaction decodes, because the required behaviour changed by maintainer decision.

## 2026-09-22 — Capture script serializes bigints as strings (maintainer-approved Phase 2 fix)

`scripts/capture-fixture.ts` now writes with a `JSON.stringify` replacer that turns every `bigint` into a decimal string. Needed because kit returns bigints inside the untyped `meta.err` of failed transactions (`{ InstructionError: [0n, { Custom: 7n }] }`), which made the script crash. Consequence, visible in fixtures: bigints inside `err` are stored as strings (`{ "InstructionError": ["0", { "Custom": "7" }] }`), consistent with how slots and lamports were already stored. `loadFixtureFile` keeps `err` as-is (`unknown`), so consumers must not assume numeric types inside it.

With this, the failed v1 transaction cited as evidence (`2TYLLmgr…`, slot 449506996) is now a fixture, `fixtures/v1-failed-transaction.json`, tested in `decoders/v1-fixture.test.ts` (version 1, inline config priority fee 700 / CU limit 76636 / loaded-accounts limit 13631488, two System transfers decoded, three unknown-program gaps, error preserved). This closes the "could not be captured" note in the v1-support entry above.

## 2026-09-22 — Phase 3B package versions

All exact pins, confirmed against `registry.npmjs.org` on 2026-09-22 (each is the current `latest`, or matches the pinned `@solana/kit` 8.3.0 line). Sizes are npm unpacked sizes; the web bundle only pulls what is imported.

| Package | Version | Where | Purpose | Size | Alternatives considered |
|---|---|---|---|---|---|
| `fflate` | 0.8.3 | core runtime | zlib/gzip inflate of IDLs, streamed so the 5 MB output cap is enforced while inflating | 797 KB (MIT, no deps) | `DecompressionStream` (async only, no way to stop a bomb mid-stream portably); `pako` (larger). `AGENTS.md` names fflate. |
| `@codama/dynamic-parsers` | 1.4.2 | core runtime | Codama's dynamic parser: identifies an instruction by discriminator (restricted to the program's own address) and decodes data + account names from a `RootNode`. It exists and fits, so no hand-written Borsh decoder was needed (3B.1). | 155 KB; pulls `@codama/dynamic-codecs` 1.3.0 (304 KB), `@codama/visitors-core`, `@codama/errors` | Hand-written IDL Borsh decoder (the phase's fallback), not needed. |
| `@codama/nodes-from-anchor` | 1.5.6 | core runtime (was root devDependency only) | Converts legacy (pre-0.30) and new (`metadata.spec: "0.1.0"`) Anchor IDLs to Codama nodes | 822 KB; pulls `@noble/hashes` 2.4.0 (legacy discriminators) | none that handles both formats |
| `@codama/nodes` | 1.11.0 | core runtime | `RootNode` / `InstructionNode` types imported directly | 1.1 MB (types + node helpers) | already a transitive dependency of the two above |
| `@solana-program/program-metadata` | 0.10.0 | core **dev** | Cross-check of the Program Metadata PDA derivation (`findMetadataPda`) in tests. Not a runtime dependency: it bundles a CLI (`commander`, `yaml`, `smol-toml`, `pako`, `picocolors`); the one account layout needed is hand-written from its generated source. | 1.8 MB | — |
| `@solana/sysvars` | 8.3.0 | core **dev** | Cross-check of the sysvar label list against the official `SYSVAR_*_ADDRESS` constants | 426 KB | — |
| `fake-indexeddb` | 6.2.5 | web **dev** | Tests of the IndexedDB IDL cache in Node (maintainer decision) | 340 KB (Apache-2.0) | testing in a browser (no browser test runner yet) |

Tooling changes: `resolveJsonModule` enabled in `tsconfig.base.json` (the registry and i18n catalogs are JSON files, imported with `with { type: "json" }`, as the phase specifies); `packages/cli/tsconfig.json` sets `"types": ["node"]` (TypeScript 7 no longer loads `@types/*` implicitly, and the CLI is a Node program; core's tests only got Node types through Vitest's own references); `apps/web/tsconfig.json` adds the `DOM` lib (IndexedDB types).

## 2026-09-22 — Third-party IDLs (3B.1)

- **Where**: for a program with no built-in decoder, Vigil reads, in one `getMultipleAccounts` call, (1) the canonical Program Metadata account for seed `idl` (PDA of `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S` with seeds `[program, <None → zero bytes>, "idl" padded to 16 bytes]`, cross-checked against `findMetadataPda`) and (2) the Anchor IDL account (`create_with_seed(find_program_address(&[], program), "anchor:idl", program)`). Program Metadata wins; the Anchor account is the fallback, **also when the Program Metadata account exists but is unusable**. Lookups run after lookup tables resolve, inside `decodeMessageWithLookups` (new optional `DecodeOptions { idl?: IdlOptions | false }`, threaded through `decodeRawTransaction` and `decodeVaultTransactionMessage`).
- **Not followed (maintainer decision)**: Program Metadata data stored at a **URL** is never fetched (outside the RPC allowlist, and a phishing vector); it produces the `IDL_AT_URL` gap, whose plain-language text tells the signer the program's own description could not be read and the instruction's effect is unknown. Data stored in **another account** (`External`) produces `IDL_UNSUPPORTED`. *Possible improvement*: support `External` (one more allowlisted account read) if it turns out to be common.
- Also refused, as `IDL_UNSUPPORTED`: YAML/TOML formats and non-UTF-8 encodings; as `IDL_INVALID`: non-canonical accounts, wrong owner, wrong discriminator, a different `program` field. `format: None` is accepted when the content parses as JSON (Whirlpool, Raydium CPMM and marginfi publish their IDL with `format: None`).
- **Limits**: compressed payload ≤ 1 MB (checked from the length field before reading); inflate is streamed in 1 KB input slices and stopped as soon as output exceeds 5 MB (deflate expands ≤ ~1032:1, so at most ~1 MB is produced past the check); `JSON.parse` only; minimal structure checks; a read **timeout** (default 10 s) on the IDL account fetch → `IDL_FETCH_FAILED`.
  - Decoding with an IDL is synchronous and cannot be interrupted by a timer, so instead IDLs that could make it hang are refused up front: any array/set/map whose items take zero bytes (a `u32`-prefixed vector of empty structs would loop up to 2³² times). *Known limit*: decoding cost is otherwise bounded by instruction size (≤ 1,232 bytes, or a v1 transaction's size).
- **Content validation**: every `name` in the raw Anchor JSON and every node name after conversion must be a plain ASCII identifier (`[A-Za-z_][A-Za-z0-9_]{0,127}`). Checked on the raw JSON too because the conversion camel-cases names and silently drops characters it does not understand (`tr\u0430nsfer`, with a Cyrillic `а` (U+0430), would otherwise become the ASCII `trNsfer`). The 128 limit (not 64) is because real IDLs have long names (pump.fun: a 70-character error name). An IDL declaring another program address is refused; other programs bundled in an IDL are dropped; the IDL is pinned to the program it was read for.
- **Provenance**: instructions decoded from an IDL have `decoder: "anchor-idl" | "program-metadata-idl"` and `provenance: "idl-declared"`, including argument and account names. Their summary is the generic `ix.idl.call` ("Calls “x” on a program with no built-in decoder … not verified"). The IDL's own program name is never used as `programLabel` (a program could name itself `squadsMultisigProgram`); `programLabel` comes only from the registry.
- **Cache**: `IdlCache { get, set }` in core, key `<program>:<sha256 hex of the IDL account data>`; value = the validated JSON text, which is **re-validated on every read** (a tampered cache is treated like chain data). Cache errors are ignored. Implementations, not yet wired to core (the CLI and web phases do that; each declares the same two-method interface structurally instead of importing core, which would need the workspace build order sorted out first):
  - CLI `FileIdlCache` (`packages/cli/src/idl-cache.ts`): `$XDG_CACHE_HOME/vigil/idl/` (a relative `XDG_CACHE_HOME` is ignored, per the XDG spec) or `~/.cache/vigil/idl/`; directory `0700`, files `0600`, atomic write (temp + rename), keys validated by regex so nothing escapes the directory, entries > 5 MB ignored.
  - Web `IndexedDbIdlCache` (`apps/web/src/idl-cache.ts`): database `vigil`, store `idl`, total cap 20 MB (default), least-recently-used eviction, injected clock; any IndexedDB failure behaves as an empty cache.
- **Noise**: `@codama/nodes-from-anchor` prints "PDA name collision" warnings to stderr for some real IDLs (pump.fun, Whirlpool). Harmless; not suppressed (that would mean patching `console`). The CLI phase may want to capture it.

**Discrepancies with `docs/reference.md` found here**:
- §6/§10: the Anchor IDL account discriminator is `sha256("internal:IdlAccount")[..8]`, **not** `sha256("account:IdlAccount")`: `IdlAccount` is declared `#[account("internal")]`, and a namespace argument replaces the `account` prefix (`lang/attribute/account/src/lib.rs`, `gen_discriminator(namespace, account_name)`, anchor commit `cc9f6b1c5e4a646bc592486a7bd485a8357a028d`). Confirmed on the three real IDL accounts in `fixtures/idl-programs.json` (all `184662bf3a907b9e`).
- §10: at the same Anchor commit the on-chain IDL account is marked deprecated in favour of Program Metadata (`deprecated_legacy_idl_usage`), which is why Program Metadata is tried first.
- §1: Program Metadata `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S` confirmed (`PROGRAM_METADATA_PROGRAM_ADDRESS` in `@solana-program/program-metadata@0.10.0`). Its `Metadata` header is 96 bytes (`program/src/state/header.rs`, `#[repr(C)]`, align 1, at commit `b618644b45667681d38ad5f920258d06b519eaf0`); the data is exactly `data_length` bytes after it.

**Real-data tests** (`fixtures/idl-programs.json`, `packages/core/src/idl/idl.test.ts`): new-format Anchor IDL — pump.fun `distributeFeeToHolders` (args, 11 named accounts, remaining accounts left unnamed); legacy Anchor IDL — Marinade `deposit`; Program Metadata — Raydium CPMM `swapBaseInput`; Whirlpool (both locations) proves the Program Metadata-first order; **Squads v4's own legacy on-chain IDL decodes all six Squads instructions of `squads-create-with-lookup-table.json` to the same names and account roles as the generated client**. URL/external/YAML/non-UTF-8/non-canonical cases are real accounts with one header byte changed.

## 2026-09-22 — Sanitizer (3B.3)

- `sanitizeOnchainString(s, kind = "text")` → `{ text, modified, flags }`, `kind` ∈ `name`/`symbol` (64 code points), `memo`/`text` (512). Removes the ranges in `docs/reference.md` §11 (newline kept only in memos), truncates by code point (never splits a surrogate pair) *after* removal, flags `non-ascii` in symbols and `mixed-scripts` (Latin with Cyrillic/Greek, via `\p{Script=…}`) in names, symbols and text. Never normalizes (NFC/NFKC would silently change what the chain says).
- **Applied to every on-chain string in instruction arguments** by a deep pass in `decodeInstruction`, for every decoder: memos (Phase 3A, `memo` fields keep newlines), System/Stake seeds, Squads memos, and every string an IDL decodes. `args` holds the sanitized text; what changed or was flagged is listed in a new optional `DecodedInstruction.sanitizer: { path, modified, flags }[]`. Lower-case hex strings the decoders build from byte arrays are exempt (they cannot carry anything to remove, and truncating them would lose data). Also applied to declared token names/symbols and to imported user labels.
- **Source hygiene**: while writing these tests, the file-writing tool decoded `\uXXXX` escapes into literal bidi/zero-width characters in source files (the "Trojan Source" problem: code that reads differently from what it is). They were converted back to escapes (commit `10fdb0e` for the sanitizer tests), and `packages/core/src/source-hygiene.test.ts` now fails if any file under `packages/ apps/ scripts/ docs/ fixtures/` contains a literal bidi, zero-width or no-break-space character.
- *Possible improvements* (not in reference §11, so not done): Unicode tag characters (U+E0000–U+E007F), U+2028/U+2029 line/paragraph separators, and other invisible format characters (`\p{Cf}`) could also be removed or flagged.

## 2026-09-22 — Registry, labels and token amounts (3B.2)

- **Registry** (`packages/core/src/registry/programs.json`, `tokens.json`), validated at load, each entry with its `source`:
  - Programs: every program in reference §1 plus the current Memo address `Memo4c2p…` (see the Phase 3A discrepancy) and the two legacy memo addresses. Program names match the decoders' labels (test). Program entries apply on every cluster.
  - Tokens (mainnet only; a mint address means nothing on another cluster): USDC (Circle docs), USDT (Tether), wSOL (`native_mint.rs`), mSOL (Marinade docs), JitoSOL (`jito-foundation/jito-tip-router` `JITOSOL_MINT`), JupSOL (`jup-ag/platform-list`), INF (`igneous-labs/inf-jup-interface` `INF_MINT_ADDR`). Each one's owner program and decimals are checked against the live mint in `fixtures/registry-mints.json` (test).
  - **bSOL left out**: no official SolBlaze source listing the mint could be found (docs page did not contain it; no match in the SolBlaze GitHub org). Can be added once confirmed.
- **Declared token metadata**, only for mints not in the registry and always shown with the mint address: the Token-2022 `TokenMetadata` extension inside the mint first (extension type 19; TLV `u16` type + `u16` length after the 165-byte base + 1-byte account type, `interface/src/extension/mod.rs` at token-2022 commit `bc9c3fa9`; `TokenMetadata` layout from `token-metadata` `interface/src/state.rs` at `7176d78e`), else Metaplex `Metadata` at `["metadata", program, mint]` (`Key::MetadataV1 = 4`, `update_authority`, `mint`, `Data { name, symbol, … }`, mpl-token-metadata commit `353d01be`; the NUL padding is stripped as layout). Both sanitized (`name`, `symbol`). Tested on real PENGU/IDLE/TRUMP (Metaplex) and Tesla/Circle xStock (Token-2022) mints.
- **Token amounts (maintainer decision: option A)**: for Token/Token-2022 `transfer`/`approve` (unchecked) the source token account is read to learn the mint, then the mint for its decimals (`mintTo`/`burn` read the mint directly; `*Checked` carry decimals). At most two `getMultipleAccounts` calls. When an account cannot be read the amount stays in base units and a `TOKEN_DECIMALS_UNKNOWN` gap is added; the summary then says "base units … (decimals unknown)". The source/destination token accounts are read too, so the destination's **owner** is shown ("to 99pb…6WHB (token account 6jzs…4LKC)") and a token account owned by a labelled vault is named after the vault ("from Vault #0", as in the phase's example).
- **Labels**: `DecodedAccount.label` is now `{ key, params, source }` (an i18n key, like summaries) instead of a string — see the contract entry below. Sources and precedence: this multisig (the multisig, its vaults, their token accounts, its members) > registry (programs, "USDC mint") > sysvars (list cross-checked against `@solana/sysvars`) > user labels. A user label never renames anything Vigil derived itself, so an imported label file cannot relabel a vault or USDC.
  - **Vaults (maintainer decision)**: indices 0–15 plus the proposal's own `vaultIndex` are derived and labelled. **An unlabelled address may still be a vault of this multisig at a higher index.**
  - **User labels**: JSON `{ "format": "vigil-labels", "version": 1, "labels": [{ "address", "label" }] }`, ≤ 1 MB, ≤ 10,000 entries, `JSON.parse` only, labels sanitized as names; invalid, duplicate, empty and sanitized entries are reported, not silently dropped; export is sorted and deterministic. Persistence belongs to the CLI and web phases.
- `annotateInstructions(rpc, instructions, { cluster, multisig?, userLabels? })` runs token enrichment then labelling and returns `{ instructions, tokens: TokenInfo[], gaps }`. Where `tokens` goes in the `AnalysisReport` is for the report-assembly phase.

## 2026-09-22 — Plain-language summaries (3B.4)

- Catalogs: `packages/core/src/i18n/en.json` and `pt-PT.json` (295 keys each). Keys: `ix.<decoder key>.<instruction>` (every native **and** Squads instruction, plus `ix.idl.call`), `label.*` (with `.short` inline forms), `gap.<CODE>` for every gap code, `authority.*` (all SPL Token and Token-2022 authority types), `fmt.*`. `renderSummary(instruction, locale)` returns `{ text, missing }`; `renderLabel`, `renderGap`, `formatAmount`, `shortAddress` are exported for the interfaces.
- Template syntax: `{param}` or `{param:type}` with types `address` (label if the account has one, else `Gh3w…Lq7m`), `sol`, `token` (uses `decimals` + registry `symbol`, or declared name/symbol + mint), `number`, `authority`, `stakeAuthorize`. A `<key>.without.<param>` entry is used when that param is missing or `"none"` (e.g. "the program can never be changed again" when a loader `SetAuthority` has no new authority).
- Summary params: the generic builder now also flattens nested argument objects with dotted keys (`newMember.key`, `arg0.staker`) and adds `<array>.count`; previously only top-level scalars were kept.
- Amounts are formatted with bigint arithmetic, trailing fractional zeros trimmed. pt-PT uses a decimal comma and a no-break space between thousands, **grouping from 4 digits** (CLDR's pt-PT minimum grouping is 5 digits; kept uniform for readability of amounts). Wording of pt-PT uses European Portuguese ("Cofre n.º 0", "Levanta", "descodificar").
- `ProgramDecoder` gained `instructionNames` (every name `decode` can return; from the official client enums where one exists) so tests can prove every instruction has a summary in both languages; `kind` now also covers the IDL decoder kinds.
- Tests: identical key sets and identical placeholders in both languages; every decoder name in both languages (> 400 checks); every gap code and authority type; exact example sentences on the real Squads proposal in both languages; every instruction of every fixture renders with no missing values and no stray braces.

## 2026-09-22 — `AnalysisReport` contract changes in Phase 3B

- `DecodedAccount.label`: `string` → `AccountLabel { key, params, source: "multisig" | "registry" | "sysvar" | "user" }`, so labels are translatable and interfaces can mark user labels as the user's own.
- `DecodedInstruction.sanitizer?: { path, modified, flags }[]` (see the sanitizer entry).
- New gap codes: `TOKEN_DECIMALS_UNKNOWN`, `IDL_FETCH_FAILED`, `IDL_INVALID`, `IDL_AT_URL`, `IDL_UNSUPPORTED`; the codes are now also a runtime list, `ANALYSIS_GAP_CODES`.
- `decoder: "anchor-idl" | "program-metadata-idl"` and `provenance: "idl-declared"` are now produced.
- Summary params may contain `mint`, `decimals`, `symbol`, `declaredName`, `declaredSymbol`, `destinationOwner` (added by token enrichment).

## 2026-09-22 — Phase 3B fixtures

Captured with `scripts/capture-fixture.ts` (allowlisted methods only, public mainnet RPC); each file's `description` says what is in it and why.

- `idl-programs.json`: IDL accounts (both locations) of pump.fun, Marinade, Raydium CPMM, Whirlpool, Squads v4 and Drift, and one real transaction each for pump.fun, Marinade and Raydium CPMM. Found by probing well-known programs; only ~1 in 4 probed had a Program Metadata IDL.
- `squads-token-transfers.json`: Squads proposal `euBTzbwH…` (vault #0 of `HpGrGa8t…`) with six unchecked SPL `transfer`s and two Token-2022 `transferChecked`, with source and destination token accounts, mints and Metaplex metadata. Found after roughly 400 recent transactions with top-level Token instructions (USDC/USDT/BONK mint activity, two exchange wallets, the Token program itself) contained **no** unchecked `transfer` at all: wallets use `transferChecked`; the unchecked form turned up inside automated Squads proposals. Re-captured once to add the destination token accounts (the transaction is historical and unchanged; token accounts' mint and owner fields do not change, and the destination owner matches the recipient named in the proposal's own memo).
- `registry-mints.json`: every registry mint and its Metaplex metadata.
