# Nib Acceptance GitHub Action

Use this Action to link a GitHub App installation to a Nib acceptance project, publish an acceptance manifest, and verify that an approved review still satisfies a gate.

This Action is currently source-only in this repository. Do not use a Marketplace-style `@v1` reference for this Action; no reusable tag is shipped in this checkout. In workflows that run from this repository, check out the repository first and use the local path:

```yaml
- uses: actions/checkout@v4
- uses: ./integrations/github-action
```

For another repository before the Action is published, check out `douglance/nib` at an explicit commit that contains `integrations/github-action`, then use that checkout-relative path:

```yaml
- uses: actions/checkout@v4

- uses: actions/checkout@v4
  with:
    repository: douglance/nib
    ref: <published-commit-sha>
    path: .nib/nib

- uses: ./.nib/nib/integrations/github-action
  with:
    mode: publish
    project-id: ${{ vars.NIB_PROJECT_ID }}
    manifest-path: .nib/acceptance/manifest.json
```

The Action requires `permissions: id-token: write` because every mode requests a GitHub Actions OIDC token with audience `nib.acceptance/v1`. It runs on the runtime declared in `action.yml`: `node24`.

## Link a repository

Run `mode: link` once from a trusted workflow on the repository default branch after the Nib Acceptance GitHub App is installed on that repository. The server accepts the link only when the signed GitHub OIDC claims come from `push` or `workflow_dispatch` on the target repository's default branch, and the workflow ref belongs to that repository on that branch.

`setup-token` is an existing authenticated Nib session token for an individual project administrator. It is sent as `Authorization: Bearer <setup-token>` to create or update the GitHub integration. Store it only long enough for bootstrap and remove the secret after link mode succeeds.

```yaml
name: Link Nib acceptance

on:
  workflow_dispatch:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  link:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./integrations/github-action
        with:
          mode: link
          project-id: ${{ vars.NIB_PROJECT_ID }}
          setup-token: ${{ secrets.NIB_ACCEPTANCE_SETUP_TOKEN }}
          installation-id: ${{ vars.NIB_GITHUB_INSTALLATION_ID }}
          allowed-workflows: ${{ github.workflow_ref }}
          gates: acceptance
```

Link mode reads `repository-id` from `GITHUB_REPOSITORY_ID` and `repository` from `GITHUB_REPOSITORY` unless you provide those inputs. `allowed-workflows` defaults to `GITHUB_WORKFLOW_REF`. `gates` is optional and limits which acceptance gates the linked workflow may update.

## Publish a review

Run `mode: publish` from an allowed linked workflow. The Action exchanges GitHub OIDC for a short-lived Nib workflow token, reads the manifest JSON, computes its canonical SHA-256, and publishes `{manifest}` to `/api/acceptance/v1/projects/:projectId/reviews`.

```yaml
- uses: actions/checkout@v4
- uses: ./integrations/github-action
  id: acceptance-publish
  with:
    mode: publish
    project-id: ${{ vars.NIB_PROJECT_ID }}
    manifest-path: .nib/acceptance/manifest.json
```

For manifests with `build.provider: "cloudflare"`, publish mode also verifies the live Cloudflare Worker version and preview URL against the local Cloudflare state file before it publishes. Provide `cloudflare-state-path` and either Cloudflare inputs or the matching environment variables:

Publish idempotency includes the canonical manifest hash, so same-run matrices may publish multiple manifests to the same project without colliding.

```yaml
- uses: ./integrations/github-action
  id: acceptance-publish
  with:
    mode: publish
    project-id: ${{ vars.NIB_PROJECT_ID }}
    manifest-path: .nib/cloudflare-previews/business-rules-manifest.json
    cloudflare-state-path: .nib/cloudflare-previews/business-rules-state.json
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## Verify a gate

Run `mode: verify` after reviewers approve the current review. Verify mode checks that `manifest-path` hashes to `manifest-hash` and that `manifest.build.commit` matches `commit` or `GITHUB_SHA`. It then calls `/api/acceptance/v1/projects/:projectId/reviews/:reviewId/verify` and fails the workflow unless the response is satisfied and includes a receipt.

By default, verify mode checks once and fails immediately when the review is still pending. Set `wait-timeout-seconds` to a positive integer to wait only while the API response state is `pending`; the Action polls every 15 seconds until approval, timeout, a terminal non-approved state, or a request error. Each poll refreshes GitHub OIDC, exchanges a new short-lived workflow token, and uses idempotency keyed by the OIDC token hash. For Cloudflare manifests, every poll probes the live Worker version and preview URL before calling `/verify`, so the final approved verification carries a fresh provider attestation.

```yaml
- uses: actions/checkout@v4
- uses: ./integrations/github-action
  id: acceptance-verify
  with:
    mode: verify
    project-id: ${{ vars.NIB_PROJECT_ID }}
    review-id: ${{ needs.publish.outputs.review-id }}
    manifest-hash: ${{ needs.publish.outputs.manifest-hash }}
    manifest-path: .nib/acceptance/manifest.json
    commit: ${{ github.sha }}
    wait-timeout-seconds: 1800
```

For Cloudflare manifests, verify mode runs the same live provider check before the acceptance API call and sends `deploymentVerification` with `manifestHash`, `commit`, and `verifiedAt`. The server accepts that provider attestation only from project automation with `verify` scope and only while it is fresh.

```yaml
- uses: ./integrations/github-action
  id: acceptance-verify
  with:
    mode: verify
    project-id: ${{ vars.NIB_PROJECT_ID }}
    review-id: ${{ needs.publish.outputs.review-id }}
    manifest-hash: ${{ needs.publish.outputs.manifest-hash }}
    manifest-path: .nib/cloudflare-previews/business-rules-manifest.json
    cloudflare-state-path: .nib/cloudflare-previews/business-rules-state.json
    commit: ${{ github.sha }}
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## Inputs

| Input | Modes | Required | Default | Purpose |
| --- | --- | --- | --- | --- |
| `api-origin` | `link`, `publish`, `verify` | No | `https://nibtool.com` | Nib API origin. |
| `mode` | All | Yes | None | `link`, `publish`, or `verify`. |
| `project-id` | All | Yes | None | Nib acceptance project ID. |
| `setup-token` | `link` | Yes | None | Existing Nib project-admin session token used only to bootstrap the GitHub integration. |
| `installation-id` | `link` | Yes | None | GitHub App installation ID. |
| `repository-id` | `link` | No | `GITHUB_REPOSITORY_ID` | GitHub repository ID to link. |
| `repository` | `link` | No | `GITHUB_REPOSITORY` | GitHub repository in `owner/name` form. |
| `allowed-workflows` | `link` | No | `GITHUB_WORKFLOW_REF` | Comma- or newline-separated workflow refs allowed to publish or verify. |
| `gates` | `link` | No | None | Comma- or newline-separated acceptance gates the integration may update. |
| `manifest-path` | `publish`, `verify` | Yes | None | Path to the acceptance manifest JSON. |
| `review-id` | `verify` | Yes | None | Review ID to verify. |
| `manifest-hash` | `verify` | Yes | None | Expected canonical SHA-256 of `manifest-path`. |
| `commit` | `verify` | No | `GITHUB_SHA` | Expected commit SHA. |
| `wait-timeout-seconds` | `verify` | No | `0` | Seconds to wait while the review remains pending. |
| `cloudflare-state-path` | Cloudflare `publish`, Cloudflare `verify` | Yes for Cloudflare manifests | None | Path to the Cloudflare preview state JSON. |
| `cloudflare-account-id` | Cloudflare `publish`, Cloudflare `verify` | No | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID for live provider checks. |
| `cloudflare-api-token` | Cloudflare `publish`, Cloudflare `verify` | No | `CLOUDFLARE_API_TOKEN` | Cloudflare API token for live provider checks. |

## Outputs

| Output | Modes | Meaning |
| --- | --- | --- |
| `review-id` | `publish`, `verify` | Published or verified review ID. |
| `review-url` | `publish`, `verify` | Review URL returned by the API or built from `api-origin`. |
| `manifest-hash` | `publish`, `verify` | Canonical SHA-256 of the manifest. |
| `state` | All | `linked` or `disabled` in link mode; review state in publish and verify modes. |
| `satisfied` | `publish`, `verify` | `true` only when the review is approved or verification succeeds. |
| `receipt` | `publish`, `verify` | Compact JWS receipt when present. |
| `repository-id` | `link` | Linked GitHub repository ID. |
| `repository` | `link` | Linked GitHub repository in `owner/name` form. |

## Failure behavior

The Action fails before contacting the acceptance API when required inputs are missing, GitHub OIDC is unavailable, the local manifest hash does not match `manifest-hash`, or the expected commit does not match `manifest.build.commit`.

Cloudflare publish and verify fail before acceptance publication or verification when the Cloudflare state file is missing, the state digest does not match its contents, the manifest hash differs from the state file, the live Worker version differs from the manifest, or the live preview URL differs from the manifest.

Verify mode fails the workflow when the acceptance API returns `satisfied: false` outside the bounded pending wait, when pending lasts longer than `wait-timeout-seconds`, when the API reports a mismatched manifest hash, or when a satisfied response omits a receipt.
