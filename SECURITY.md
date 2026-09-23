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

## Response commitment

We aim to acknowledge new reports within 5 business days and to provide an initial assessment (validity, severity, and expected timeline) within 10 business days. Timelines may slip for complex issues; we will communicate delays rather than go silent.

Credit will be given in the fix's release notes unless the reporter asks to remain anonymous.
