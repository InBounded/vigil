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
