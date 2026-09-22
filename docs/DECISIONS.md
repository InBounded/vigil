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
