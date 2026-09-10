# Nib Acceptance Workflow Templates

These templates are source examples for the Nib acceptance pilot. They assume the Nib `apps/web` and `apps/cloudflare` layout. Copy them into a repository's `.github/workflows` directory after replacing the documented placeholder values with reviewed production values.

Use `setup-link.default-branch.yml` once from the default branch after installing the Nib Acceptance GitHub App. It links the current repository to one Nib project by checking out the reviewed Nib source SHA and running the local Action in `mode: link`. Replace `owner/application-repository/.github/workflows/nib-acceptance-pilot.reusable.yml@0123456789abcdef0123456789abcdef01234567` with the exact pinned reusable workflow ref used by the caller so setup allowlists both the setup workflow and the pinned reusable workflow. Remove `NIB_ACCEPTANCE_SETUP_TOKEN` after the link job succeeds.

Use `pr-pilot.caller.yml` in the application repository to publish reviews for same-repo PR merge refs before merge. Replace the reusable workflow `uses:` owner, repository, and 40-character ref with the application repository commit that contains `nib-acceptance-pilot.reusable.yml`. Forked PRs do not call the reusable workflow.

Use `nib-acceptance-pilot.reusable.yml` as that trusted reusable workflow. It builds `github.sha`, which is the `refs/pull/<number>/merge` commit for `pull_request` events, once in a no-secret job. The reusable workflow also checks the event and repository itself, so direct misuse outside a same-repo `pull_request` event skips both jobs. It uploads only prebuilt Worker bundles and site assets. The deploy job always uses the fixed `acceptance-pilot` environment, checks out `douglance/nib` at admin-controlled `NIB_ACCEPTANCE_ACTION_SHA`, prepares trusted recipes and seed fixtures there, binds trusted generated Wrangler configs to the downloaded prebuilt files with `no_bundle: true`, then deploys, publishes, and verifies the three pilot gates. The verify step waits up to 1800 seconds only while the review is pending.

The artifact contract between build and deploy is:

- `.nib/pilot/prebuilt/nib-site/**`
- `.nib/pilot/prebuilt/nib-global/**`
- `.nib/pilot/prebuilt/nib/**`
- `.nib/pilot/assets/site-assets/**`
- `.nib/pilot/SHA256SUMS`

The binder uses the following exact emitted entries and preserves additional modules with `find_additional_modules: true`:

| Component | Required entry | Additional artifact |
| --- | --- | --- |
| `nib-site` | `shim.js` | Compiled `.wasm` file |
| `nib-global` | `index.js` | None required |
| `nib` | `index.js` | Site assets in the separate assets directory |

Wrangler runs from each component's package directory so the site custom build resolves correctly. Relocated configs retain absolute migration directory paths before the preview adapter generates its final configs.

The deploy job verifies `SHA256SUMS` and runs the trusted adapter from the pinned Nib checkout. Do not add build, package-install, recipe preparation, seed preparation, or repository-local script execution from the PR artifact to the deploy job.

Run the local dry-run validator after changing these templates:

```sh
node integrations/github-app/workflows/pilot-prebuilt-contract.mjs validate-local-dry-run
```

That validator uses synthetic prebuilt files so CI does not need Rust, `worker-build`, or actual Wrangler bundle output for this contract check. To build the actual bundles and dry-run the generated `no_bundle` configs for all three examples, run:

```sh
node integrations/github-app/workflows/pilot-prebuilt-contract.mjs validate-actual-wrangler-dry-run
```
