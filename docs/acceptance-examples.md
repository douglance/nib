# Acceptance examples

Run the three local examples with Node 24 from the repository root:

```sh
npm ci --prefix apps/web
npm ci --prefix apps/cloudflare
node apps/web/scripts/acceptance-example-runner.mjs --example all --output .tmp/acceptance-examples/all.json
```

Use `--example onboarding`, `business-rules`, or `permissions` to run one. The process exits unsuccessfully if any assertion fails. CI runs all three and checks fixture SQL against every production migration.

| Example | Executed local behavior |
| --- | --- |
| Onboarding | Authenticated request creation and listing through the public Worker and real review service; acceptance page read, evidence upload, approval, and current verification. |
| Business rules | Billing status and invalid-plan rejection; checkout with mocked Stripe; paid generation with mocked AI; actual isolated queue send matched to its D1 usage ledger; three successful trial identities and a fourth denied by the network limit; revision request, supersession, two-person quorum, and signed receipt verification. |
| Permissions | Viewer read access and denied publishing, voting, invalidation, and credential creation; scoped automation publication and verification; device registration and account isolation through the public Worker. |

The harness runs the actual public Worker, review service, D1, R2, and SQLite Durable Objects in Miniflare/workerd. Production entitlement rules run against isolated local bindings. Stripe and AI responses are mocked; unexpected external fetches fail. Email is local-only, APNs is unconfigured, and the site binding serves a test shell. The runner does not prove real notification delivery, rendered preview behavior, or deployment to Cloudflare. It creates disposable local accounts and removes its runtime storage after each example. URLs in its JSON are test evidence, not hosted review links.

Local manifests use provider `external`; the runner never submits a fabricated Cloudflare version attestation. Optional `--commit`, `--repository-id`, `--repository-owner`, `--repository-name`, and `--preview-base-url` label local manifests only. Changing the URL does not turn this runner into a remote test.

## Prepare the hosted examples

The three `examples/acceptance/*/recipe.json` files retain the deployable `nib.cloudflare-preview/v1` contract. They deploy the public Worker with private site/review dependencies and isolated state. Source templates deliberately contain placeholder project/build identifiers. Prepare a concrete copy before deployment:

```sh
# Set these to the real receiving project and repository revision.
export NIB_ACCEPTANCE_PROJECT_ID="your-project-uuid"
export NIB_ACCEPTANCE_COMMIT="your-40-character-commit"
export NIB_ACCEPTANCE_REPOSITORY_ID="your-numeric-repository-id"
export NIB_ACCEPTANCE_REPOSITORY="owner/repository"
export NIB_ACCEPTANCE_PILOT_ONBOARDING_EMAIL="pilot-onboarding@example.com"
export NIB_ACCEPTANCE_PREVIEW_AUTH_RATE_LIMIT_SECRET="new-preview-only-random-value"
export NIB_ACCEPTANCE_PREVIEW_ACCEPTANCE_SIGNING_JWK="new-preview-only-ed25519-private-jwk"
node examples/acceptance/prepare.mjs onboarding .nib/acceptance/onboarding.json
node integrations/cloudflare/bin/nib-cloudflare-preview.mjs plan --recipe .nib/acceptance/onboarding.json
```

Repeat preparation with `business-rules` and `permissions`. `NIB_ACCEPTANCE_REVISION` can distinguish multiple preview revisions of the same commit. For PR workflows, set `NIB_ACCEPTANCE_SUBJECT` to `github:owner/repository:pull/NUMBER` so workflow provenance matches the subject.

Hosted preparation requires these pilot email inputs:

| Example | Required pilot email variables |
| --- | --- |
| Onboarding | `NIB_ACCEPTANCE_PILOT_ONBOARDING_EMAIL` |
| Business rules | `NIB_ACCEPTANCE_PILOT_BUSINESS_RULES_EMAIL` |
| Permissions | `NIB_ACCEPTANCE_PILOT_PERMISSIONS_OWNER_EMAIL`, `NIB_ACCEPTANCE_PILOT_PERMISSIONS_ADMIN_EMAIL`, `NIB_ACCEPTANCE_PILOT_PERMISSIONS_REVIEWER_EMAIL`, `NIB_ACCEPTANCE_PILOT_PERMISSIONS_VIEWER_EMAIL` |

The prepared recipe writes concrete fixture copies next to the output recipe and rewrites seed paths to those files. Prepared seeds contain real pilot email addresses, no reusable passwords, and no session tokens. Hosted pilot users sign in through the normal email-code flow. The generated Wrangler config keeps the `EMAIL` binding restricted to the same pilot recipients with `allowed_destination_addresses`.

Hosted deployment also requires preview-only secret values. All recipe secret refs must use `NIB_ACCEPTANCE_PREVIEW_*` env names. Do not point these at production secret variables or copy production secret values. `business-rules` also needs `NIB_ACCEPTANCE_PREVIEW_TRIAL_NETWORK_SECRET` and `NIB_ACCEPTANCE_PREVIEW_STRIPE_SECRET_KEY`.

Follow [Cloudflare previews](acceptance-cloudflare.md) to build assets, deploy, publish the resulting manifest, verify, and invalidate before cleanup. The receiving Nib project is separate from the fixture project inside the preview. Create automation credentials through the project API after authenticating as an administrator.

The onboarding seed creates one pilot account for normal login. The business-rule seed creates an available trial on the current account schema. The permissions seed creates a distinct owner plus project admin, reviewer, and viewer; the project admin has only member privileges at the team level. Replaying these seeds preserves exercised trial and permission state. The seeds were applied through real Wrangler local D1 migrations and queries before source delivery.

Publishing the three hosted examples remains part of the [day-30 audit](acceptance-30d-audit.md). Record actual deployment IDs, review URLs, evidence, decisions, and current verification results there. Passing the local runner alone does not complete that requirement.
