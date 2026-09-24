# Security Policy

Vigil is a read-only security-analysis tool. It never handles private keys, never signs, and never sends transactions — but it does parse hostile, attacker-controlled on-chain data (transaction bytes, memos, token metadata, program IDLs) and present it to people making custody decisions. Bugs here can directly mislead a signer, so we treat security reports seriously.

## Reporting a vulnerability

Please report vulnerabilities privately through **GitHub Private Vulnerability Reporting**:

1. Go to the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Describe the issue, including reproduction steps, affected package (`@vigil-sol/core`, `@vigil-sol/cli`, `@vigil/web`, `@vigil/rpc-proxy`), and potential impact.

Do not open a public GitHub issue for a suspected vulnerability.

If you cannot use GitHub Private Vulnerability Reporting for any reason, contact a maintainer listed in [`docs/maintainers.md`](docs/maintainers.md).

## Scope

**In scope:**
- Incorrect decoding or risk classification that could cause a proposal to be misrepresented as less dangerous than it is.
- Any code path that could cause Vigil to request, log, transmit, or persist a private key or seed phrase.
- Any code path that signs or broadcasts a transaction.
- Injection vulnerabilities (e.g. unsanitized on-chain strings rendered as HTML).
- Supply-chain issues (compromised dependency, unpinned CI action, install scripts).
- Vulnerabilities in the RPC proxy (`@vigil/rpc-proxy`) that could allow it to forward non-allowlisted RPC methods.

**Out of scope:**
- Vulnerabilities in the Squads v4 program itself, Solana core, or other third-party programs Vigil merely reads — report those to their respective maintainers.
- Findings that require a user to already have a compromised machine or browser extension.

## RPC proxy: what it sees and keeps

The optional RPC proxy (`apps/rpc-proxy`, a Cloudflare Worker) lets the hosted web app read mainnet without the signer setting up an endpoint. What it does with requests:

- **No logging.** The Worker contains no logging call (a test fails if one appears); request bodies, IP addresses and the upstream URL are never written anywhere by it. Workers Logs, Logpush and source-map upload are disabled in `wrangler.jsonc`, and maintainers do not attach Tail Workers or leave `wrangler tail` running (`docs/maintainers.md`).
- **What remains is Cloudflare's default.** Cloudflare terminates the connection and keeps its own default Workers metrics (request counts, errors, CPU time) for the account owner. That is outside Vigil's code and is covered by Cloudflare's privacy policy.
- **The client IP is used only as the rate-limit key** (counted by Cloudflare's rate limiting binding, or by the Worker's fallback in the memory of one isolate, never written out). It is never forwarded: the upstream RPC receives only the checked JSON-RPC calls, with no client header, `Origin` or IP.
- **The upstream RPC URL and its API key** are a Worker secret. They are never returned in a response, including upstream error pages, which are replaced by a generic error.
- **Only the allowlisted read methods** (`docs/reference.md` §4) are forwarded, `simulateTransaction` only with `sigVerify: false`, `getSignaturesForAddress` only with a `limit` of at most 100, batches of at most 10 calls and bodies of at most 16 KB. Everything else is refused (HTTP 403 for methods and parameters).
- **Origins.** Only the configured web app origins get CORS access, and requests without an `Origin` header are refused. A non-browser client can forge `Origin`, so this keeps casual reuse out but is **not** access control: the per-IP rate limit is the real protection against abuse of the shared key. Anyone who needs more should set their own RPC endpoint in the web app's settings.

Using the proxy means trusting its operator and the upstream provider to return honest chain data, as with any RPC endpoint. Signers who want an independent source should set their own endpoint (it always takes precedence) and, optionally, a second one for the cross-check (VGL-C012).

## Response commitment

We aim to acknowledge new reports within 5 business days and to provide an initial assessment (validity, severity, and expected timeline) within 10 business days. Timelines may slip for complex issues; we will communicate delays rather than go silent.

Credit will be given in the fix's release notes unless the reporter asks to remain anonymous.
