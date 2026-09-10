# Acceptance Operations

Acceptance v1 is fail-closed. Keep `ACCEPTANCE_ENABLED` set to `"false"` until the production Worker has its secrets, migrations, Queue, Durable Object, email, and GitHub App configured. Verify the live flow under the pilot allowlists before opening wider access.

## Runtime configuration

`apps/web/wrangler.jsonc` declares the production bindings used by acceptance:

| Binding or variable | Purpose |
| --- | --- |
| `ACCEPTANCE_ENABLED` | Global feature flag. The checked-in default is `"false"`. The public API requires `"true"` before any acceptance gate can pass. |
| `ACCEPTANCE_PILOT_ACCOUNT_IDS` | Optional comma-separated account IDs permitted to use acceptance during a restricted pilot. Setting either pilot variable activates both restrictions. |
| `ACCEPTANCE_PILOT_PROJECT_IDS` | Optional comma-separated project IDs permitted during the pilot. An empty or missing list denies that category of access while pilot mode is active. |
| `ACCEPTANCE` | Durable Object namespace for one `AcceptanceCoordinator` per project. |
| `ACCEPTANCE_EVENTS` | Queue for `acceptance.changed` events. |
| `ARTIFACTS` | R2 bucket for acceptance evidence bytes. |
| `EMAIL` | Cloudflare Email binding used for invitations and acceptance notifications. |
| `REVIEW` | Service binding to the existing review service for account device notifications. |
| `PUBLIC_ORIGIN` | Origin used for review, evidence, invitation, and JWKS URLs. |
| `ACCEPTANCE_SIGNING_JWK` | Private JWK used to sign approved acceptance receipts. Store as a Wrangler secret. |
| `ACCEPTANCE_SIGNING_KEY_ID` | Key ID placed in receipt JWS headers and JWKS responses. Store as a Wrangler secret or non-secret variable. |
| `ACCEPTANCE_VERIFICATION_JWKS` | Optional JWKS containing previous public keys during receipt key rotation. |
| `GITHUB_APP_ID` | GitHub App ID used to create installation tokens. |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key. Store as a Wrangler secret. |
| `GITHUB_WEBHOOK_SECRET` | Secret used to verify GitHub webhooks. Store as a Wrangler secret. |
| `ACCEPTANCE_GITHUB_OIDC_AUDIENCE` | Optional override for the GitHub Actions OIDC audience. Defaults to `nib.acceptance/v1`. |

The public JWKS endpoint is `GET /.well-known/acceptance-jwks.json`. It combines the current signing public key with `ACCEPTANCE_VERIFICATION_JWKS` and sets `cache-control: public, max-age=300`.

Direct acceptance evidence uploads are limited to 16 MiB because the Worker buffers each upload to compute its SHA-256 before writing content-addressed bytes to R2. This keeps the upload path within the 128 MiB Worker heap. Store larger evidence outside Nib and publish the external URL with a SHA-256 descriptor in the manifest.

## Rollout

Apply D1 migrations before enabling the flag:

```sh
npx wrangler d1 migrations apply nib --remote
```

The acceptance migrations currently present in this checkout are:

| Migration | Adds |
| --- | --- |
| `0015_acceptance_teams.sql` | Teams, team members, invitations, projects, project members, project credentials, and account-level idempotency. |
| `0016_acceptance_integrations.sql` | Integration idempotency, stored acceptance events, GitHub installation/OIDC/check state, and customer webhook delivery state. |
| `0017_acceptance_delivery_and_evidence.sql` | Evidence storage metadata, upload idempotency, and notification delivery leases. |
| `0018_acceptance_usage.sql` | Acceptance usage events for review publication, page views, preview opens, and decisions. |
| `0019_acceptance_provider_verifications.sql` | Short-lived provider verification attestations keyed by project, automation actor, idempotency key, review, manifest hash, commit, and expiry. |
| `0020_acceptance_github_pr_provenance.sql` | Separates the deployed build commit from the GitHub-verified PR head and records that provenance for publication and checks. |

The Durable Object migration tag is `v4-acceptance`, which adds `AcceptanceCoordinator`. The Queue binding uses `nib-acceptance-events` with `nib-acceptance-events-dlq`.

### Restricted pilot

Register the GitHub App with the [local manifest helper](../integrations/github-app/README.md), install it on the selected repository, and configure its three Worker secrets before starting the trial. Keep credential values out of logs, manifests, and workflow artifacts.

For the initial internal trial:

1. Set `ACCEPTANCE_PILOT_ACCOUNT_IDS` to the individual account ID and `ACCEPTANCE_PILOT_PROJECT_IDS` to an empty string, then set `ACCEPTANCE_ENABLED` to `"true"`.
2. Sign in normally and create the pilot team and project. The new project ID is returned by creation, but project access remains denied until it is listed.
3. Add that project ID to `ACCEPTANCE_PILOT_PROJECT_IDS`, link the trusted GitHub workflows, and run the live checks below. Use quorum one for a one-person internal trial.

Pilot configuration does not grant team or project permissions. It also closes public review/evidence links, restricts automation to listed projects, filters reviewer eligibility and notifications to listed accounts, and prevents team-level changes from altering unlisted projects. Invitations require an existing listed account. Queued invitations and webhooks outside the pilot do not consume the pilot delivery batch.

Signed GitHub lifecycle webhooks remain active while acceptance or pilot access is paused. Reconciliation changes existing checks to failure for paused projects. The public receipt-key endpoint remains available for offline verification.

To add another pilot, provision its account and project access before the observed trial and record those grants separately from any help given during the trial. Removing both pilot variables restores ordinary acceptance access when the global flag is true; leaving either variable present with empty lists keeps the pilot closed. To pause all acceptance, set `ACCEPTANCE_ENABLED` to `"false"` and retain the database and signing keys.

Before opening wider access, prove the pilot runtime can:

1. Return `200` from `/health` and a JWKS from `/.well-known/acceptance-jwks.json`.
2. Create a team, project, and scoped credential through `/api/acceptance/v1`.
3. Publish a review into the project Durable Object and send its `acceptance.changed` event through `ACCEPTANCE_EVENTS`.
4. Deliver email/device notifications and prove failed deliveries retry through the Queue.
5. Verify an approved current review through `/verify`. For Cloudflare manifests, report a fresh authorized provider attestation, then prove `/verify` fails closed with `cloudflare_current_version_unverified` after it expires.

Project admins can read acceptance usage metrics at `GET /api/acceptance/v1/projects/:projectId/metrics`. The response aggregates total event counts, distinct review and reviewer counts, first-use timestamps, GitHub install timing, and repeat usage. Metrics are written idempotently to `acceptance_usage_events`; they are product-usage telemetry, not evidence that a reviewer tested the preview.

## GitHub integration

GitHub integration requires a GitHub App, not arbitrary repository claims from callers. Configure the app credentials in Worker secrets, set the webhook URL to:

```text
https://nibtool.com/api/acceptance/v1/github/webhook
```

Link from the repository's default branch with the Action's `link` mode, as described in [GitHub Action setup](../integrations/github-action/README.md). A project administrator must also provide a signed GitHub ownership proof; knowing an installation ID is insufficient to authorize a link.

The equivalent authenticated API request is:

```sh
curl -X PUT "$NIB_ORIGIN/api/acceptance/v1/projects/$PROJECT_ID/integrations/github" \
  -H "Authorization: Bearer $NIB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: github-installation-1" \
  --data '{
    "installationId":"123456",
    "repositoryId":"987654",
    "owner":"douglance",
    "name":"nib",
    "ownershipOidcToken":"<fresh-default-branch-GitHub-OIDC-token>",
    "allowedWorkflows":["douglance/nib/.github/workflows/acceptance.yml@refs/heads/main"],
    "gates":["pilot-business-rules"]
  }'
```

The Worker verifies the installation against GitHub and the signed ownership proof before saving it. The proof must identify the target repository, its actual default branch, and a `push` or `workflow_dispatch` event from an allowed workflow on that branch. Missing, forged, cross-repository, PR-event, and other-branch proofs fail closed. See GitHub's [OIDC claim reference](https://docs.github.com/en/actions/reference/security/oidc).

During a workflow, `/api/acceptance/v1/github/token` requires `Idempotency-Key` and returns a 10-minute bearer token scoped to `publish` or `verify` after checking GitHub OIDC. A workflow publication must match the repository ID, repository owner/name, workflow SHA, and pull-request subject derived from the trusted claims. If the installation is disabled, removed, suspended, or no longer allows the workflow ref, stored workflow tokens stop authenticating.

GitHub pull-request webhooks update stored pull heads. When the head SHA changes, current reviews for that pull-request subject are invalidated with reason `GitHub pull request head changed.`. GitHub `installation` `deleted` or `suspend` events disable every stored repository for that installation and revoke its unexpired workflow tokens. GitHub `installation_repositories` `removed` events disable only the removed repositories and revoke their unexpired workflow tokens.

GitHub webhook handling stays reachable while `ACCEPTANCE_ENABLED` is `"false"` so pause and rollback do not leave repository access active. Other acceptance routes, including workflow-token exchange and gate verification, return `503` through the public API while the global flag is off.

## Cloudflare acceptance previews

Use the Cloudflare adapter in `integrations/cloudflare` for Cloudflare-backed manifests. The adapter is dry-run by default and requires `--allow-live` for live resource changes.

```sh
node integrations/cloudflare/bin/nib-cloudflare-preview.mjs deploy \
  --recipe examples/acceptance/business-rules/recipe.json \
  --allow-live \
  --out .nib/cloudflare-previews/business-rules-manifest.json \
  --state-out .nib/cloudflare-previews/business-rules-state.json
```

The adapter deploys isolated per-revision Worker names and isolated D1, R2, Queue, and service-binding targets. It records owned preview resources in `state.json`. Live verification and teardown require that state file; a manifest alone is not enough to prove resource ownership.

Before publishing a Cloudflare manifest, run:

```sh
node integrations/cloudflare/bin/nib-cloudflare-preview.mjs verify-cloudflare \
  --manifest .nib/cloudflare-previews/business-rules-manifest.json \
  --state .nib/cloudflare-previews/business-rules-state.json
```

Publish only after Cloudflare verification passes:

```sh
node integrations/cloudflare/bin/nib-cloudflare-preview.mjs publish \
  --manifest .nib/cloudflare-previews/business-rules-manifest.json \
  --acceptance-url "$NIB_ORIGIN"
```

The adapter reads `NIB_ACCEPTANCE_TOKEN` unless `--token` or `--token-env` is supplied.

The `/verify` API fails closed for Cloudflare manifests unless the exact review has a provider attestation from the past 60 seconds. The attestation body is `{"manifestHash":"<sha256>","commit":"<sha>","verifiedAt":"<ISO-8601>"}` under `deploymentVerification`, and the server accepts it only from project automation with `verify` scope. Customer-side automation holds the Cloudflare credentials, probes the live provider state, and reports only the bounded freshness result to Nib.

The `verify` scope authorizes automation to assert provider freshness. Grant it only to trusted workflows: Nib authenticates the report and limits its lifetime, but does not independently contact Cloudflare or receive a Cloudflare-signed proof.

## Queues and retries

`AcceptanceCoordinator` writes each mutation to Durable Object storage and an outbox. Its alarm sends outbox events to `ACCEPTANCE_EVENTS` and keeps retrying while unsent events remain.

The Worker Queue consumer sends each acceptance event to both integration delivery and account notification delivery. If either path fails, the message is retried with a 30-second delay. Wrangler config allows up to 10 retries before the dead-letter queue.

Team invitations use a separate D1-backed email outbox. Invitation create and resend mutations write the email row in the same idempotent batch as the invitation change, then drain up to 20 unsent invitation emails after that batch succeeds.

When global acceptance is enabled, the minute cron (`* * * * *`) also drains pending invitation emails. The same cron always replays queued customer webhooks and reconciles stale GitHub checks. Customer webhooks can also be replayed manually:

```sh
curl -X POST "$NIB_ORIGIN/api/acceptance/v1/projects/$PROJECT_ID/integrations/webhooks/$WEBHOOK_ID/deliveries/$DELIVERY_ID/replay" \
  -H "Authorization: Bearer $NIB_AUTH_TOKEN" \
  -H "Idempotency-Key: webhook-replay-$DELIVERY_ID"
```

Customer webhook deliveries are signed with `x-nib-signature: t=<unix-seconds>,v1=<hmac-sha256>`, and use the per-webhook secret returned only at creation.

## Current validation boundary

The acceptance implementation has source, native compile, local runtime, and [staged production deployment evidence](acceptance-deployment-20260909.md). Deployment access works through apoc's `lv` profile; earlier authentication failures used no workspace profile. Production health and disabled-gate checks passed. GitHub App registration, live notifications, hosted examples, and the unaided-team pilot remain unverified. Native compile and tests do not prove device behavior.

See [Acceptance v1 validation](acceptance-validation.md) for the executed checks and their limits. Use [Acceptance day-30 audit](acceptance-30d-audit.md) to track the production App registration, three published examples, and new-user review-without-help evidence required before calling the day-30 scope complete.

## Receipt rotation

Accepted reviews receive a compact EdDSA JWS receipt. Acceptance v1 supports only Ed25519 JWKs in the Worker and local offline packet verifier.

To rotate keys:

1. Add the current public JWKS to `ACCEPTANCE_VERIFICATION_JWKS`.
2. Set the new private key in `ACCEPTANCE_SIGNING_JWK`.
3. Set a new `ACCEPTANCE_SIGNING_KEY_ID`.
4. Deploy and verify `/.well-known/acceptance-jwks.json` exposes old and new public keys.
5. Keep old public keys until exported packets and still-valid receipts no longer need historical verification.

## Rollback

Rollback must preserve the fail-closed property:

1. Set `ACCEPTANCE_ENABLED` back to `"false"` or disable the affected project.
2. Verify live gates and GitHub workflow-token exchange return `503` through the public API while signed GitHub webhooks still verify and record installation revocations.
3. Verify live gates return `satisfied: false`.
4. Leave D1 migrations in place. They are additive and forward-only.
5. Inspect `nib-acceptance-events` and `nib-acceptance-events-dlq` before replaying anything.
6. Replay only idempotent Queue, webhook, or GitHub reconciliation work after confirming the stored idempotency keys and current review state.

For Cloudflare preview teardown, invalidate the acceptance review first and verify that it no longer satisfies the gate before deleting preview resources:

```sh
node integrations/cloudflare/bin/nib-cloudflare-preview.mjs invalidate \
  --acceptance-url "$NIB_ORIGIN" \
  --project-id "$PROJECT_ID" \
  --review-id "$REVIEW_ID" \
  --reason "Cloudflare preview teardown"

node integrations/cloudflare/bin/nib-cloudflare-preview.mjs teardown \
  --state .nib/cloudflare-previews/business-rules-state.json \
  --acceptance-url "$NIB_ORIGIN" \
  --review-id "$REVIEW_ID" \
  --allow-live
```

Teardown deletes only the preview Workers, R2 objects, D1 databases, R2 buckets, and Queues recorded in `state.json`.
