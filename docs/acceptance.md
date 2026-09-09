# Acceptance

Nib acceptance records human approval for a specific project, subject, gate, manifest, and build. It is implemented in the public `apps/web` Worker under `/api/acceptance/v1`, with one `AcceptanceCoordinator` Durable Object per project.

Acceptance is implemented in this checkout, but it is disabled by default in `apps/web/wrangler.jsonc` with `ACCEPTANCE_ENABLED = "false"`. A disabled global flag or disabled project fails closed and cannot satisfy a gate. Do not treat the feature as live customer validation until the Worker has been deployed, configured, and canaried in that environment.

## Setup Path

1. Sign in with a Nib account.
2. Create a team.
3. Invite reviewers by email.
4. Create a project for the gate.
5. Add explicit project members when team membership is not enough.
6. Create a project automation credential or link a trusted GitHub workflow.
7. Publish an acceptance manifest from CI.
8. Ask reviewers to open the review page, inspect the preview, and approve, reject, or request a revision.
9. Gate deploys with live verification against the current approved review.

Acceptance is project-scoped. Custom roles, SSO, pricing, and a second provider are not implemented in this version.

## Roles

| Actor | Project access |
| --- | --- |
| Team owner | Inherits project `admin` on every team project. Can manage the team, transfer ownership, archive the team, create projects, and manage members. |
| Team admin | Inherits project `admin` on every team project. Can manage team settings, invitations, projects, and project access. |
| Team member | Can list team projects only when explicitly assigned to a project. |
| Project admin | Can read, publish, review, and manage a project. |
| Project reviewer | Can read, comment, approve, reject, or request revision. |
| Project viewer | Can read project reviews. |
| Project credential | Can use only its `publish`, `read`, and/or `verify` scopes. It cannot vote or manage membership. |
| GitHub workflow token | Can publish or verify only after the Worker exchanges trusted GitHub OIDC claims for a short-lived project token. |

Reviewers eligible at publish time are team owners, team admins, project admins, and project reviewers. Pending reads reconcile live membership and drop pending votes from reviewers who are no longer eligible. Settled history is retained.

## Team And Project API

Project, team, review, evidence, and customer webhook mutations require `Idempotency-Key`. GitHub OIDC token exchange and GitHub webhooks use their own OIDC or HMAC verification and do not require an idempotency key. JSON errors use:

```json
{"error":{"code":"idempotency_key_required","message":"Provide an Idempotency-Key of 1 to 200 characters."}}
```

Mutations routed through the review API also require `Content-Type: application/json` and reject a cross-origin `Origin` header.

Create a team:

```sh
curl -X POST "$NIB_ORIGIN/api/acceptance/v1/teams" \
  -H "Authorization: Bearer $NIB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: team-create-1" \
  --data '{"name":"Release Review"}'
```

Response:

```json
{
  "team": {
    "id": "team-id",
    "name": "Release Review",
    "defaultQuorum": 1,
    "defaultTtlSeconds": 604800,
    "role": "owner"
  }
}
```

Invite a reviewer:

```sh
curl -X POST "$NIB_ORIGIN/api/acceptance/v1/teams/$TEAM_ID/invitations" \
  -H "Authorization: Bearer $NIB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: invite-reviewer-1" \
  --data '{"email":"reviewer@example.com","role":"member"}'
```

Invitations expire after seven days, store only a hashed token, and can be accepted only by the invited email address:

```sh
curl -X POST "$NIB_ORIGIN/api/acceptance/v1/invitations/$INVITATION_TOKEN/accept" \
  -H "Authorization: Bearer $NIB_AUTH_TOKEN" \
  -H "Idempotency-Key: invitation-accept-1"
```

Create a project:

```sh
curl -X POST "$NIB_ORIGIN/api/acceptance/v1/teams/$TEAM_ID/projects" \
  -H "Authorization: Bearer $NIB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: project-create-1" \
  --data '{"name":"Production deploy","slug":"production-deploy","quorum":1,"ttlSeconds":604800,"publicRead":false,"enabled":true}'
```

Assign a project reviewer:

```sh
curl -X PUT "$NIB_ORIGIN/api/acceptance/v1/projects/$PROJECT_ID/members/$ACCOUNT_ID" \
  -H "Authorization: Bearer $NIB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: project-member-1" \
  --data '{"role":"reviewer"}'
```

Create an automation credential:

```sh
curl -X POST "$NIB_ORIGIN/api/acceptance/v1/projects/$PROJECT_ID/credentials" \
  -H "Authorization: Bearer $NIB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: project-credential-1" \
  --data '{"name":"release workflow","scopes":["publish","verify"]}'
```

The response includes `token` once. Store it as a CI secret and use it as `Authorization: Bearer`.

## Manifest

Publish accepts `{manifest}`. The manifest hash is the SHA-256 of canonical JSON.

```json
{
  "manifest": {
    "contract": "nib.acceptance/v1",
    "projectId": "00000000-0000-4000-8000-000000000202",
    "subject": "github:douglance/nib:pull/123",
    "gate": "pilot-business-rules",
    "title": "Billing business-rule acceptance",
    "request": "Confirm that usage metering and trial limits behave correctly in the Cloudflare preview.",
    "change": "Deploys the public Worker, site Worker, and review service into an isolated acceptance preview stack.",
    "criteria": [
      {
        "id": "trial-limit",
        "text": "A seeded trial account stops billable generation after the configured trial network identity limit.",
        "verification": "Run the business-rules smoke against the preview URL and attach the test output."
      }
    ],
    "build": {
      "repository": {"id": "nib", "owner": "douglance", "name": "nib"},
      "commit": "replace-with-ci-commit-sha",
      "provider": "cloudflare",
      "previewUrl": "https://preview.example.workers.dev",
      "deployment": {
        "id": "cloudflare-deployment-id",
        "components": [
          {"name": "nib", "versionId": "worker-version-id", "kind": "worker"}
        ],
        "configSha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "assetsSha256": "1111111111111111111111111111111111111111111111111111111111111111"
      },
      "assumptions": [
        "D1, R2, Queue, and Durable Object state is isolated by per-revision resource names and seeded fixtures."
      ]
    },
    "evidence": []
  }
}
```

`criteria`, `evidence`, `build.assumptions`, and `build.deployment.components` are each capped at 100 entries. `build.provider` is `cloudflare` or `external`.

Direct evidence uploads to Nib are capped at 16 MiB. The Worker hashes each upload before it writes the content-addressed bytes to R2, so the upload body is buffered inside the 128 MiB Worker heap. Store larger artifacts outside Nib and put a stable `url`, `sha256`, and optional `contentType` in the manifest evidence descriptor. Nib validates Nib-owned evidence URLs against the same project and SHA-256 before publication; external evidence URLs are accepted as hashed references and must remain available to reviewers.

## Route Reference

| Route | Method | Body |
| --- | --- | --- |
| `/api/acceptance/v1/teams` | `GET` | None |
| `/api/acceptance/v1/teams` | `POST` | `{"name":"Release Review"}` |
| `/api/acceptance/v1/teams/:teamId` | `GET`, `DELETE` | None |
| `/api/acceptance/v1/teams/:teamId` | `PATCH` | `{"name":"Release Review","defaultQuorum":1,"defaultTtlSeconds":604800}` |
| `/api/acceptance/v1/teams/:teamId/members` | `GET` | None |
| `/api/acceptance/v1/teams/:teamId/members/:accountId` | `GET`, `DELETE` | None |
| `/api/acceptance/v1/teams/:teamId/members/:accountId` | `PUT`, `PATCH` | `{"role":"admin"}` or `{"role":"member"}`. Use `/transfer` for `owner`. |
| `/api/acceptance/v1/teams/:teamId/invitations` | `GET` | None |
| `/api/acceptance/v1/teams/:teamId/invitations` | `POST` | `{"email":"reviewer@example.com","role":"member"}`. Role can be `admin` or `member`. |
| `/api/acceptance/v1/teams/:teamId/invitations/:invitationId` | `DELETE` | None |
| `/api/acceptance/v1/teams/:teamId/invitations/:invitationId/resend` | `POST` | None |
| `/api/acceptance/v1/invitations/:token/accept` | `POST` | None |
| `/api/acceptance/v1/teams/:teamId/transfer` | `POST` | `{"accountId":"next-owner-account-id"}` |
| `/api/acceptance/v1/teams/:teamId/projects` | `GET` | None |
| `/api/acceptance/v1/teams/:teamId/projects` | `POST` | `{"name":"Production deploy","slug":"production-deploy","quorum":1,"ttlSeconds":604800,"publicRead":false,"enabled":true}` |
| `/api/acceptance/v1/projects/:projectId` | `GET`, `DELETE` | None |
| `/api/acceptance/v1/projects/:projectId` | `PATCH` | `{"name":"Production deploy","slug":"production-deploy","quorum":1,"ttlSeconds":604800,"publicRead":false,"enabled":true}` |
| `/api/acceptance/v1/projects/:projectId/members/:accountId` | `PUT`, `PATCH` | `{"role":"admin"}`, `{"role":"reviewer"}`, or `{"role":"viewer"}` |
| `/api/acceptance/v1/projects/:projectId/members` | `GET` | None |
| `/api/acceptance/v1/projects/:projectId/members/:accountId` | `GET`, `DELETE` | None |
| `/api/acceptance/v1/projects/:projectId/credentials` | `GET` | None |
| `/api/acceptance/v1/projects/:projectId/credentials` | `POST` | `{"name":"release workflow","scopes":["publish","verify"]}` |
| `/api/acceptance/v1/projects/:projectId/credentials/:credentialId` | `GET`, `DELETE` | None |
| `/api/acceptance/v1/projects/:projectId/evidence` | `POST` | Raw evidence bytes up to 16 MiB with `Content-Type` set to `image/png`, `image/jpeg`, `image/webp`, `video/mp4`, `application/pdf`, `text/plain`, or `application/json`; optional `X-Nib-Filename`. |
| `/api/acceptance/v1/projects/:projectId/evidence/:sha256` | `GET` | None |
| `/api/acceptance/v1/projects/:projectId/metrics` | `GET` | None. Project admin only. |
| `/api/acceptance/v1/projects/:projectId/reviews` | `GET` | None |
| `/api/acceptance/v1/projects/:projectId/reviews` | `POST` | `{"manifest":{...}}` |
| `/api/acceptance/v1/projects/:projectId/current?subject=...&gate=...` | `GET` | None |
| `/api/acceptance/v1/projects/:projectId/reviews/:reviewId` | `GET` | None |
| `/api/acceptance/v1/projects/:projectId/reviews/:reviewId/export` | `GET` | None |
| `/api/acceptance/v1/projects/:projectId/reviews/:reviewId/decisions` | `POST` | `{"decision":"approve","criteriaIds":["trial-limit"]}` or `{"decision":"reject","comment":"reason","criteriaIds":["trial-limit"]}` |
| `/api/acceptance/v1/projects/:projectId/reviews/:reviewId/comments` | `POST` | `{"text":"Looks correct on the preview."}` |
| `/api/acceptance/v1/projects/:projectId/reviews/:reviewId/preview-open` | `POST` | `{}` |
| `/api/acceptance/v1/projects/:projectId/reviews/:reviewId/viewed` | `POST` | `{}` |
| `/api/acceptance/v1/projects/:projectId/reviews/:reviewId/invalidate` | `POST` | `{"reason":"Preview was torn down."}` |
| `/api/acceptance/v1/projects/:projectId/reviews/:reviewId/verify` | `POST` | `{"manifestHash":"<sha256>","commit":"<sha>","subject":"<subject>","gate":"<gate>","deploymentVerification":{"manifestHash":"<sha256>","commit":"<sha>","verifiedAt":"<ISO-8601>"}}`. `deploymentVerification` is only accepted from project automation with `verify` scope. |
| `/api/acceptance/v1/projects/:projectId/integrations/github` | `GET` | None |
| `/api/acceptance/v1/projects/:projectId/integrations/github` | `PUT`, `POST` | `{"installationId":"123456","repositoryId":"987654","owner":"douglance","name":"nib","ownershipOidcToken":"<fresh-default-branch-proof>","allowedWorkflows":["douglance/nib/.github/workflows/acceptance.yml@refs/heads/main"],"gates":["pilot-business-rules"]}` |
| `/api/acceptance/v1/projects/:projectId/integrations/github?repository_id=987654` | `DELETE` | None |
| `/api/acceptance/v1/github/token` | `POST` | `{"oidcToken":"<github-oidc-token>","projectId":"<project-id>","mode":"publish"}` |
| `/api/acceptance/v1/github/webhook` | `POST` | GitHub webhook JSON with `x-hub-signature-256`, `x-github-delivery`, and `x-github-event`. |
| `/api/acceptance/v1/projects/:projectId/integrations/webhooks` | `GET` | None |
| `/api/acceptance/v1/projects/:projectId/integrations/webhooks` | `POST` | `{"url":"https://example.com/nib-acceptance","description":"release checks","events":["acceptance.changed"]}` |
| `/api/acceptance/v1/projects/:projectId/integrations/webhooks/:webhookId` | `PATCH` | `{"url":"https://example.com/nib-acceptance","description":"release checks","events":["acceptance.changed"],"enabled":true}` |
| `/api/acceptance/v1/projects/:projectId/integrations/webhooks/:webhookId` | `DELETE` | None |
| `/api/acceptance/v1/projects/:projectId/integrations/webhooks/:webhookId/deliveries/:deliveryId/replay` | `POST` | None |

## Review API

Publish a review:

```sh
curl -X POST "$NIB_ORIGIN/api/acceptance/v1/projects/$PROJECT_ID/reviews" \
  -H "Authorization: Bearer $NIB_ACCEPTANCE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: publish-$MANIFEST_HASH" \
  --data @publish-body.json
```

The response includes the review record and `reviewUrl`. Review state is one of `pending`, `approved`, `rejected`, `revision_requested`, `expired`, `superseded`, or `invalidated`.

Record a decision:

```sh
curl -X POST "$NIB_ORIGIN/api/acceptance/v1/projects/$PROJECT_ID/reviews/$REVIEW_ID/decisions" \
  -H "Authorization: Bearer $NIB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: decision-$REVIEW_ID-$ACCOUNT_ID" \
  --data '{"decision":"approve","criteriaIds":["trial-limit"]}'
```

Approvals must acknowledge every manifest criterion. Reject and revision decisions require `comment`. Any reject or revision request settles the review immediately. Comments alone do not settle a review, and preview-open events are only activity signals.

Verify a gate live:

```sh
curl -X POST "$NIB_ORIGIN/api/acceptance/v1/projects/$PROJECT_ID/reviews/$REVIEW_ID/verify" \
  -H "Authorization: Bearer $NIB_ACCEPTANCE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: verify-$REVIEW_ID-$MANIFEST_HASH" \
  --data '{"manifestHash":"'$MANIFEST_HASH'","commit":"'$GITHUB_SHA'","subject":"github:douglance/nib:pull/123","gate":"pilot-business-rules"}'
```

Successful live verification requires the review to be current, approved, unexpired, and receipted. For `build.provider: "cloudflare"`, it also requires a fresh provider attestation for the exact review, manifest hash, and commit. The attestation expires after 60 seconds. Humans cannot submit provider attestations; only project automation with `verify` scope can report `deploymentVerification`.

The API verifies the review first, records a supplied provider attestation when authorized, checks freshness, and then rechecks the canonical review state before returning success. If the approval is otherwise valid but the Cloudflare deployment has no fresh attestation, the response is `{"satisfied":false,"reason":"cloudflare_current_version_unverified"}`. Other false results include `subject_mismatch`, `gate_mismatch`, `manifest_hash_mismatch`, `commit_mismatch`, `not_current`, `not_approved`, or `missing_receipt`.

## CLI

`nib feedback --packet` uploads any packaged evidence bytes, publishes a derived manifest with server evidence URLs, and waits by default. The source packet remains immutable. Packaged evidence larger than 16 MiB cannot be uploaded directly to Nib; use an external evidence URL with a SHA-256 descriptor for those artifacts.

```sh
nib feedback --packet review.nib --project "$PROJECT_ID" --timeout 0 --format json
```

Resume an interrupted wait:

```sh
nib request wait "$REVIEW_ID" --project "$PROJECT_ID" --timeout 0 --format json
```

Export a server review to a portable packet. The packet stores the immutable manifest, evidence bytes when downloaded, derived vote/signature rows, and the full server review snapshot so discussion, policy, eligibility, invalidation, supersession, and future lifecycle fields survive export. The receipt signs only the receipt payload, not comments or private discussion.

```sh
nib request export "$REVIEW_ID" --project "$PROJECT_ID" --output review.nib --format json
```

Live verification checks the current server state:

```sh
nib request verify "$REVIEW_ID" --project "$PROJECT_ID" --manifest-hash "$MANIFEST_HASH" --commit "$GITHUB_SHA" --format json
```

Generic CLI verification does not run a Cloudflare provider probe. For Cloudflare manifests, it passes only while the server has a recent provider attestation from authorized automation. Use the Nib Acceptance GitHub Action for the probe-before-verify path.

Offline verification checks only historical packet integrity and receipt signature. It requires a trusted JWKS file and never proves that the review is still current:

```sh
nib request verify "$REVIEW_ID" --offline --packet review.nib --jwks acceptance-jwks.json --format json
```
