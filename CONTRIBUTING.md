# Contributing to Vigil

Thanks for your interest in Vigil. Before anything else, read [`AGENTS.md`](AGENTS.md) — it defines the non-negotiable rules this project is built under (read-only, no invented APIs, verification against official sources, no mocks where real data is required, and more). Every contribution, human or AI-assisted, is expected to follow it.

## Setup

Requirements: Node.js as pinned in [`.nvmrc`](.nvmrc), and [pnpm](https://pnpm.io/) via Corepack.

```sh
corepack enable
git clone <this repository>
cd vigil
pnpm install --frozen-lockfile
pnpm check   # lint + typecheck + test + build, exactly what CI runs
```

## Standards

- TypeScript strict mode (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) — see [`tsconfig.base.json`](tsconfig.base.json). Do not weaken it, and do not use `any`, `@ts-ignore`, or Biome lint-ignore comments without a recorded justification in [`docs/DECISIONS.md`](docs/DECISIONS.md).
- Formatting and linting are enforced by [Biome](https://biomejs.dev) (`pnpm lint`). Run it before committing; CI will reject unformatted or lint-failing code.
- Amounts (lamports, token amounts, u64 indices, slots) are always `bigint`, never `number` or floating point.
- `packages/core` performs no I/O directly — it only talks to the outside world through injected `RpcClient`, `HttpClient`, and `Clock` interfaces, so its logic stays deterministically testable offline.
- New runtime dependencies must be justified in `docs/DECISIONS.md` (purpose, alternatives considered, size, maintenance status) before being added. Prefer a platform API over a new package.
- Decoders and account readers are tested against real fixtures captured from mainnet or devnet (see `fixtures/` and `scripts/capture-fixture.ts` once Phase 2 lands), never only hand-built bytes.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).

## Adding a decoder

_To be filled in once the decoder framework exists (Phase 2 and later). In short: a decoder turns raw instruction bytes plus an IDL or hand-written layout into a `DecodedInstruction` with explicit `provenance`. This section will document the interface, where to register a new decoder, and what fixture coverage is required._

## Adding a rule

_To be filled in once the risk-rule framework exists (a later phase). In short: a rule is a pure, deterministic function over a decoded transaction that may emit a `Finding` with a stable `ruleId` (e.g. `VGL-C001`), a `severity`, and evidence. This section will document the rule interface, the `ruleId` numbering scheme, and testing expectations._

## Pull requests

- Keep PRs scoped to a single phase or a single fix — see the "YOU MUST NOT" list in `AGENTS.md` regarding working ahead.
- `pnpm check` must pass locally before opening a PR; CI re-runs the same command.
- Branch protection requires review and passing CI before merge (see `docs/maintainers.md`).
