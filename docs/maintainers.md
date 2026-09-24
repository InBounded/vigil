# Maintainer setup

Repository and org-level settings that must be configured by hand on GitHub (not something CI or code can enforce). This is a checklist for whoever administers the `vigil` repository.

## Account security

- [ ] **Mandatory two-factor authentication** for the organization (or, if this stays under a personal account, on the account itself): Settings → Authentication security → Two-factor authentication → require it for all members.

## Branch protection (`main`)

Settings → Branches → Add branch protection rule for `main`:

- [ ] Require a pull request before merging (at least 1 approval).
- [ ] Require status checks to pass before merging — select the `CI` (`check`) and `CodeQL` (`Analyze (javascript-typescript)`) checks once they've run at least once.
- [ ] Require branches to be up to date before merging.
- [ ] **Require signed commits.**
- [ ] Do not allow force pushes.
- [ ] Do not allow deletions.
- [ ] Apply the rule to administrators too (no bypass).

## Vulnerability reporting

- [ ] Settings → Security → enable **Private vulnerability reporting**, so the flow described in `SECURITY.md` actually works.
- [ ] Settings → Security → enable **Dependabot alerts** and **Dependabot security updates**.
- [ ] Settings → Security → enable **Secret scanning** and **push protection**.

## Code scanning

- [ ] After the `codeql.yml` and `scorecard.yml` workflows have run once on `main`, confirm results appear under the **Security → Code scanning** tab.
- [ ] Optionally add the OpenSSF Scorecard badge to `README.md` once a scan has published (`https://api.securityscorecards.dev/projects/github.com/<org>/<repo>/badge`).

## Signed commits

- [ ] Each maintainer configures commit signing locally (GPG or SSH signing key) and adds the public key to their GitHub account under Settings → SSH and GPG keys, so branch protection's "require signed commits" doesn't block legitimate pushes.

## Note on `scorecard.yml`'s `publish_results: true`

The Scorecard workflow as written publishes results to the public OpenSSF Scorecard dataset (`api.securityscorecards.dev`), which is standard practice for public open-source repositories and is what powers the badge above. If you'd rather not publish scan results publicly before the repo is ready for that, set `publish_results: false` in `.github/workflows/scorecard.yml` — recorded as an open decision in `docs/DECISIONS.md`.

## RPC proxy (`apps/rpc-proxy`, Cloudflare Workers)

The hosted web app uses the proxy for **mainnet** when a signer has not set an RPC endpoint of their own (order: their own endpoint → the proxy → for devnet only, the public devnet endpoint). The proxy forwards only the allowlisted read methods to one upstream mainnet RPC whose URL, API key included, is a Worker **secret**. Design and limits: `docs/DECISIONS.md`, Phase 9.

It is built for the **Workers Free plan**: no paid-only features, one upstream subrequest per call (at most 10 per batch; Free allows 50), almost no CPU per request. Free-plan limits (100,000 requests per day, 10 ms CPU per request, among others) are on Cloudflare's [limits page](https://developers.cloudflare.com/workers/platform/limits/); check them there, they change. When the daily quota is used up, Cloudflare answers with its own error and the web app shows an RPC failure that points signers to their own endpoint.

### 1. Get an upstream RPC key (free tier)

Any provider works; Helius is the example here.

1. Sign up or log in at <https://dashboard.helius.dev>.
2. In the sidebar, open **API Keys**, then **Create New API Key** and give it a name (e.g. `vigil-rpc-proxy`).
3. Copy the key once: it is not shown again.
4. The mainnet URL is `https://mainnet.helius-rpc.com/?api-key=<KEY>` (Helius [endpoints](https://www.helius.dev/docs/api-reference/endpoints)).

**Free-tier limits change without notice.** Check the provider's current numbers before relying on them — for Helius, its [rate limits page](https://www.helius.dev/docs/billing/rate-limits). They are not copied here on purpose. Helius documents IP restrictions for keys; Workers do not have fixed outbound IPs, so leave them off for this key and keep the key used for nothing else.

### 2. Deploy the Worker (step by step)

From a clean checkout, on a machine you trust (you will paste the key into it):

1. `pnpm install --frozen-lockfile`
2. `cd apps/rpc-proxy`
3. `pnpm exec wrangler login` — opens the browser to authorise Wrangler on your Cloudflare account (a free account is enough). Wrangler's usage metrics are off for this project (`send_metrics: false` in `wrangler.jsonc`, and `WRANGLER_SEND_METRICS=false` in the package scripts).
4. Build and check without uploading: `pnpm build` (runs `wrangler deploy --dry-run`; it prints the bundle size and the bindings).
5. Deploy once, with the web app origins: `pnpm run deploy --var ALLOWED_ORIGINS:https://<pages-project>.pages.dev,https://<your-domain>`
   - Origins are exact (`https://host[:port]`, no path, no trailing slash), comma-separated, `https:` only (`http:` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, for local development). Anything malformed is ignored, so a typo allows less, never more.
   - A GitHub Pages mirror's origin is `https://<user>.github.io` **for every project page of that user**: allowing it lets any of those pages call the proxy. Add it only if the mirror should use the proxy.
   - On the first deploy Wrangler may ask you to choose a `workers.dev` subdomain. The Worker's URL is then `https://vigil-rpc-proxy.<subdomain>.workers.dev`.
   - `wrangler deploy` replaces the Worker's variables with those in `wrangler.jsonc` plus `--var`, so pass `--var ALLOWED_ORIGINS:…` on **every** deploy (or edit `vars.ALLOWED_ORIGINS` in `wrangler.jsonc` in a commit).
6. Set the upstream secret: `pnpm exec wrangler secret put UPSTREAM_RPC_URL` and paste the full URL (with its key) at the prompt. Never pass it as an argument or put it in a file in the repository; `.dev.vars` is ignored by git for local development only.
7. Check it: `curl -s https://vigil-rpc-proxy.<subdomain>.workers.dev/health` must print `{"status":"ok"}`. `{"status":"not-configured"}` (HTTP 503) means the secret or `ALLOWED_ORIGINS` is missing or invalid.
8. Check a call as the web app makes it:
   ```sh
   curl -s https://vigil-rpc-proxy.<subdomain>.workers.dev/ \
     -H 'Origin: https://<pages-project>.pages.dev' -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}'
   ```
   must return the mainnet genesis hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`; the same with `"method":"sendTransaction"` must return HTTP 403.
9. **Rate limiting binding (unverified on the Free plan).** The Worker uses Cloudflare's rate limiting binding (`ratelimits` in `wrangler.jsonc`: 100 requests per 60 s per client IP, per Cloudflare location). Cloudflare's documentation does not say whether it is available on the Free plan. If the deploy refuses the binding, remove the `ratelimits` block and deploy again: the Worker then uses its built-in best-effort limit (100 per 60 s per IP, but per isolate, so looser). Record what happened in `docs/DECISIONS.md`.

### 3. Point the web app at it

Build the hosted web app (and, if wanted, the GitHub Pages mirror) with the Worker's URL:

```sh
VIGIL_PROXY_URL=https://vigil-rpc-proxy.<subdomain>.workers.dev pnpm --filter @vigil/web build
```

The URL must be plain `https://` (no key, query or fragment) or the build stops. The offline single file never uses the proxy (a page opened from disk has the origin `null`, which the proxy refuses). The web app's CSP (`connect-src 'self' https:`) already allows the proxy.

### Rotating the key or turning the proxy off

- New key: create it at the provider, `wrangler secret put UPSTREAM_RPC_URL` again, then delete the old key at the provider.
- Suspected abuse: tighten `simple.limit` in `wrangler.jsonc` and redeploy, or take the proxy down with `pnpm exec wrangler delete` — the web app then asks signers for their own endpoint (rebuild it without `VIGIL_PROXY_URL` so it stops trying the proxy).
- Do not enable Workers Logs, Logpush or Tail Workers for this Worker, and do not leave `wrangler tail` running: the no-logging promise in `SECURITY.md` depends on it.
