# Acceptance day-30 audit

Acceptance v1 is not day-30 complete. The source tree contains the acceptance API, local runtime validation, the GitHub Action source, Cloudflare preview tooling, and a GitHub App registration manifest. The Workers are staged in production with acceptance disabled. GitHub App registration, three hosted end-to-end examples, and new users reviewing without founder assistance remain unverified.

## Requirement source

The day-30 requirement source is `/Users/douglance/Downloads/business-thesis.pdf`, page 9. The source text was extracted in apoc execution `01a08451-961f-7d02-a6bb-3776af7b3680`. The relevant page-9 requirements are:

1. Ship the GitHub App-backed acceptance flow with one preview integration, reviewer checklist, comments, and signed receipt.
2. Publish three end-to-end acceptance examples.
3. Measure whether new users can review without help.

Do not mark this audit complete until each requirement below has live evidence.

## Current status

| Requirement | Source and shipped artifact evidence | Live evidence required for completion | Status |
| --- | --- | --- | --- |
| GitHub App-backed acceptance flow with one preview integration, checklist, comments, and signed receipt | `apps/web/worker/src/acceptance` implements teams, projects, reviews, comments, decisions, signed receipts, GitHub integration, and provider freshness. `integrations/cloudflare` implements the Cloudflare preview integration. `integrations/github-app/manifest.json` defines the GitHub App registration configuration. `integrations/github-action/README.md` documents source-based link, publish, and verify workflow use. Local evidence: Worker tests `01a08460-6b4a-7320-9562-f512ec5b1e23`, Action tests `01a08460-6c79-7ec2-b2b8-b025263adc47`, Cloudflare tests `01a0845f-c4dc-7010-a7c8-b9b2b40432f0`, and Web TypeScript `01a08460-6bed-7471-a8e6-a987638720f2`. | Registered GitHub App slug or ID, installed repository ID, production Worker deployment revision, configured Worker secrets, successful webhook delivery, pending check, accepted check, a later revision that blocks reuse, installation removal that revokes workflow tokens, relink that restores the allowed workflow, and a verified production receipt. | Source implemented and locally verified. Day-30 live completion is not complete. |
| Three published end-to-end acceptance examples | Deployable recipes exist under `examples/acceptance/{onboarding,business-rules,permissions}`. Preparation and all three local application flows passed; [Acceptance examples](acceptance-examples.md) contains the commands and exact evidence boundary. | Three production review URLs or exported receipts created from the published examples, each tied to a real project, commit, manifest hash, reviewer action, verification result, and evidence URL. | Not complete. Local examples and smoke output do not prove published production examples. |
| New users can review without help | `docs/acceptance.md`, `docs/acceptance-operations.md`, [GitHub App registration](../integrations/github-app/README.md), and [GitHub Action usage](../integrations/github-action/README.md) document the intended self-serve path: create team/project, link a trusted workflow, publish a manifest, review, and verify. | Observation or recorded artifacts from users who did not build the feature, completing setup, publication, review, and verification without founder or builder intervention. Include blockers, time spent, and whether they recovered from errors using the docs alone. | Not complete. No new-user review-without-help evidence is present. |

## Evidence boundary

Source and local validation support implementation readiness; the [September 9 deployment record](acceptance-deployment-20260909.md) and [September 10 pilot safeguards deployment](acceptance-deployment-20260910.md) add production Worker versions, migrations, Queues, keys, and live smoke checks. The validation record is [Acceptance v1 validation](acceptance-validation.md), including local Worker tests, GitHub Action tests, Cloudflare adapter tests, Rust checks, and browser flow evidence. That evidence does not prove GitHub App registration, hosted example publication, real email or APNs delivery, or independent pilot success.

The checked-in `apps/web/wrangler.jsonc` keeps `ACCEPTANCE_ENABLED = "false"`. A disabled global flag means production acceptance gates fail closed until the live rollout steps in [Acceptance Operations](acceptance-operations.md) are completed and verified.

## Completion evidence to attach

Record completion only when these fields are known from live systems:

| Field | Required evidence |
| --- | --- |
| GitHub App registration | App slug or ID, registration account, manifest revision used, and screenshot or API output confirming permissions and webhook URL. |
| GitHub App installation | Installation ID, repository ID, selected repository, and install timestamp. |
| Production deployment | Worker deployment IDs, `ACCEPTANCE_ENABLED` value, D1 migration state, Queue and Durable Object binding names, receipt signing key ID, and JWKS URL response. |
| Webhook and checks | GitHub delivery ID, accepted webhook response, check-run ID for a pending review, check-run ID for an accepted review, stale-revision check evidence, installation-removal revocation proof, and relink proof. |
| Published examples | Three review URLs or exported packets, manifest hashes, commits, reviewer decisions, verification receipts, and evidence URLs. Use the finalized commands in Acceptance examples and record the actual hosted results. |
| New-user review-without-help pilot | Team identity, participants, setup path used, recorded blockers, whether founder help was used, and final verification result. |

## New-user review-without-help pilot protocol

Use this protocol to prove the requirement that new users can review without help. Product metrics such as page views, preview opens, comments, decisions, and verification calls can support the record, but they cannot prove that the team was unaided.

1. Select participants who did not build the acceptance feature and record their team name, repository, roles, start time, and exact source or production build.
2. Give the team only the public self-serve materials: [Acceptance](acceptance.md), [Acceptance Operations](acceptance-operations.md), [GitHub App registration](../integrations/github-app/README.md), [GitHub Action usage](../integrations/github-action/README.md), and the three example instructions when they are published.
3. Record whether the team completes, abandons, or asks for help. Capture completion time, blocker text, and every founder or builder intervention.
4. Record the project ID, GitHub installation ID, review IDs, manifest hashes, commits, reviewer decisions, receipt IDs, and verification results produced by the team.
5. Mark the pilot passed only if the team links the repository, publishes a review, completes reviewer action, and verifies the gate without founder or builder help.

## Open blockers

- GitHub and Cloudflare access now work through apoc profile `lv`; both Nib workspace paths are mapped.
- GitHub App registration remains incomplete. A tested loopback manifest helper is ready; native browser accessibility became unavailable before registration completed.
- Pilot owner authentication did not complete before the email challenge expired. The Mac build reached code signing, then failed with unavailable keychain interaction. CI preview secrets and Stripe test prices still require configuration.
- Hosted previews, actual notification delivery, GitHub checks/webhook consumption, and the unaided-team pilot still need live evidence.
- Public Worker source `dae0026` is pushed and deployed with acceptance disabled. It adds restricted pilot access, PR provenance and live-head enforcement, preview secret bootstrap, and the registration helper. The review Worker retains source `4507426`; see the deployment records for exact versions.
