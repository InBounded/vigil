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
