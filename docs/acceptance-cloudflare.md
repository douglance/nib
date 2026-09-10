# Cloudflare Acceptance Previews

Nib acceptance previews use exact Cloudflare Worker versions plus an isolated per-revision resource stack before publishing an acceptance manifest. The default command is a dry-run plan; live Cloudflare mutation requires `--allow-live`.

## Source Checks

This adapter was matched against the local Wrangler CLI in `apps/web`:

- `wrangler 4.120.0`
- `wrangler deploy --config --name --tag --message`
- `wrangler deployments list --json`
- Cloudflare D1 REST `POST /accounts/:account_id/d1/database`, which returns `result.uuid`
- `wrangler d1 execute --remote --file`, `wrangler r2 bucket create`, `wrangler r2 object put --remote`, `wrangler r2 object delete --remote`, `wrangler queues create`, and `wrangler delete`

The Cloudflare docs say Worker versions capture code, static assets, bindings, and compatibility settings, while D1/R2/Durable Object storage state is not tracked with Worker versions. Preview stacks therefore rewrite every Worker and stateful binding to per-revision names, deploy the generated Worker names, and include only contract-safe deployment fields in the acceptance manifest. Local resource names and fixture object keys stay in `state.json`.

Useful Cloudflare references:

- Worker version preview URLs: `https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/`
- Worker versions and deployments: `https://developers.cloudflare.com/workers/versions-and-deployments/`
- Wrangler Worker commands: `https://developers.cloudflare.com/workers/wrangler/commands/workers/`
- Wrangler configuration bindings: `https://developers.cloudflare.com/workers/wrangler/configuration/`
- Service bindings: `https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/`

## CI Inputs

Run these commands from the repository root.

Required environment:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `NIB_ACCEPTANCE_TOKEN` for publishing, verifying, or invalidating an acceptance review
- `NIB_ACCEPTANCE_PREVIEW_AUTH_RATE_LIMIT_SECRET`
- `NIB_ACCEPTANCE_PREVIEW_ACCEPTANCE_SIGNING_JWK`
- `NIB_ACCEPTANCE_PREVIEW_TRIAL_NETWORK_SECRET` for `business-rules`
- `NIB_ACCEPTANCE_PREVIEW_STRIPE_SECRET_KEY` for `business-rules`

Recipe fields are under `examples/acceptance/*/recipe.json`. Use `examples/acceptance/prepare.mjs` as described in [Acceptance examples](acceptance-examples.md) to set the receiving project, repository identity, commit, revision, pilot emails, and prepared fixture files before planning or deploying. Component `vars` may explicitly override non-secret configuration. Component `secrets` name preview-only environment variables; secret values are read only during live deployment and are not written to the plan, manifest, state, or journal. The adapter rejects secret refs that do not start with `NIB_ACCEPTANCE_PREVIEW_`. The adapter preserves the configured `ENVIRONMENT`, so production-only business rules still run against the isolated resources.

## Dry-Run Inspect

```sh
node integrations/cloudflare/bin/nib-cloudflare-preview.mjs plan \
  --recipe examples/acceptance/business-rules/recipe.json \
  --out .nib/cloudflare-previews/plan.json
```

The plan prints deterministic component names, isolated D1/R2/queue names, generated Wrangler config paths, seed operations, deployment commands, and the draft Nib acceptance manifest. It does not call Cloudflare.

## Live Preview

Build any required assets before a live deployment. The public `apps/web` Worker references `apps/web/site/dist/assets`, so a pilot run for `business-rules` or `permissions` should build the site first.

```sh
cd apps/web
npm run site:build
cd ../..

node integrations/cloudflare/bin/nib-cloudflare-preview.mjs deploy \
  --recipe examples/acceptance/business-rules/recipe.json \
  --allow-live \
  --out .nib/cloudflare-previews/business-rules-manifest.json \
  --state-out .nib/cloudflare-previews/business-rules-state.json
```

For stateful Workers, the adapter:

1. Rewrites Worker names to `*-acc-*`.
2. Removes production routes, custom domains, and cron triggers.
3. Rewrites D1, R2, queue, and service-binding targets to preview names.
4. Keeps email bindings only when the prepared recipe supplies explicit `allowed_destination_addresses` for the pilot recipients; otherwise email bindings are omitted.
5. Enables `workers_dev` only for the primary preview Worker and forces `preview_urls = false`; service-binding dependencies stay private and do not receive public version preview URLs.
6. Points `PUBLIC_ORIGIN` and `NIB_ACCEPTANCE_ORIGIN` for every generated component at the primary public preview origin.
7. Creates isolated resources, writes generated Wrangler config with the created D1 database IDs, applies D1 migrations from the source `migrations_dir`, then applies prepared seed fixtures through the same generated config.
8. For components with `secrets`, performs an uncaptured bootstrap deploy, writes each preview secret with `wrangler secret put`, and then performs the final deploy.
9. Deploys service-binding dependencies before callers using generated per-revision Worker names.
10. Reads the active deployed version ID for each component from the Cloudflare deployments API after the final deploy.
11. Verifies the active deployed version ID for every component and verifies the primary Worker preview URL.
12. Writes the acceptance manifest with component version IDs, configuration digests, asset digests, and the preview URL.
13. Writes `state.json` with the owned preview Workers, isolated resources, R2 fixture object keys, and journal path.

If a planned Cloudflare Worker or resource name already exists and is not already recorded in the same plan journal, deployment stops before creation. Use a new commit/revision or teardown the prior stack. If a run fails after creating resources, migrations, seeds, bootstrap, or secret writes, retry the same recipe/revision/state directory; the journal skips completed operations and resumes the exact plan. D1 migration and seed steps require the recorded created database ID, so a journal entry without D1 ownership proof is not enough to mutate schema or data. Live deploy rejects seed files that still contain `.invalid` addresses or unresolved `__NIB_ACCEPTANCE_*__` placeholders.

## Publish And Verify

Publish the manifest to the acceptance API after Cloudflare verification passes.

```sh
node integrations/cloudflare/bin/nib-cloudflare-preview.mjs publish \
  --manifest .nib/cloudflare-previews/business-rules-manifest.json \
  --acceptance-url https://nibtool.com
```

The script posts `{manifest}` to `/api/acceptance/v1/projects/:projectId/reviews` with an idempotency key. It reads `NIB_ACCEPTANCE_TOKEN` unless `--token` or `--token-env` is supplied.

Unsatisfied CLI verification returns exit status 1. The CLI verify command requires the manifest and the matching local state file so it can refresh the Cloudflare provider attestation before calling the acceptance API:

```sh
node integrations/cloudflare/bin/nib-cloudflare-preview.mjs verify-acceptance \
  --manifest .nib/cloudflare-previews/business-rules-manifest.json \
  --state .nib/cloudflare-previews/business-rules-state.json \
  --acceptance-url https://nibtool.com \
  --review-id "$NIB_ACCEPTANCE_REVIEW_ID"
```

GitHub Actions can call the exported helper instead when a JavaScript action needs structured control:

```js
import { verifyAcceptanceGateFromManifest } from "./integrations/cloudflare/src/cloudflare-preview.mjs";

const result = await verifyAcceptanceGateFromManifest({
  acceptanceUrl: process.env.NIB_ACCEPTANCE_URL,
  token: process.env.NIB_ACCEPTANCE_TOKEN,
  manifest,
  reviewId: process.env.NIB_ACCEPTANCE_REVIEW_ID,
  api: cloudflareApi,
  localState: state,
});
```

The helper verifies the Cloudflare Worker versions and preview URL against the local `state.json` first. If Cloudflare verification passes, it sends `deploymentVerification` with `manifestHash`, `commit`, and `verifiedAt` in the acceptance verify request. The verify idempotency key includes that report hash so a fresh probe does not collide with a previous timestamped report. The helper returns the acceptance API verify response: `satisfied`, `state`, `reason`, `receipt`, `reviewId`, `revision`, and `manifestHash`.

The acceptance API now requires a fresh provider attestation for Cloudflare manifests. Generic API, CLI, and helper verification pass only while the server has a valid 60-second attestation for the exact review, manifest hash, and commit. Use the Nib Acceptance GitHub Action when verification must probe Cloudflare immediately before the acceptance API call; the action runs the same Cloudflare manifest/state check and sends `deploymentVerification` with `manifestHash`, `commit`, and `verifiedAt`.

## Invalidate And Teardown

Teardown requires authenticated acceptance invalidation and a canonical acceptance verify response with the exact review ID, manifest hash, commit, `satisfied: false`, and `state: invalidated` before deleting any Cloudflare resource. This teardown verify call does not send `deploymentVerification` and does not probe live Cloudflare versions; cleanup is allowed after invalidation even if the preview has drifted or a prior teardown already removed part of the stack. Teardown still requires the local `state.json` ownership receipt; a manifest alone is not enough to delete anything.

```sh
node integrations/cloudflare/bin/nib-cloudflare-preview.mjs invalidate \
  --acceptance-url https://nibtool.com \
  --project-id 00000000-0000-4000-8000-000000000202 \
  --review-id "$NIB_ACCEPTANCE_REVIEW_ID" \
  --reason "Cloudflare preview teardown"

node integrations/cloudflare/bin/nib-cloudflare-preview.mjs teardown \
  --state .nib/cloudflare-previews/business-rules-state.json \
  --acceptance-url https://nibtool.com \
  --review-id "$NIB_ACCEPTANCE_REVIEW_ID" \
  --allow-live
```

Teardown deletes preview Workers first, deletes only R2 fixture objects recorded in `state.json`, then deletes isolated D1, R2, and queue resources recorded in `state.json`. It refuses to run without `--allow-live`.

## Pilot Recipes

- `examples/acceptance/onboarding/recipe.json` deploys the authenticated public Worker and private dependencies with a seeded pilot account and R2 review-request fixture.
- `examples/acceptance/business-rules/recipe.json` deploys `nib`, `nib-site`, and `nib-global` with D1/R2 fixtures for trial and metering behavior.
- `examples/acceptance/permissions/recipe.json` deploys the public Worker stack with seeded acceptance team, project, role fixtures; create scoped credentials through the API.

These recipes are pilot inputs. Fixture-based tests prove adapter behavior only; they do not prove a live Cloudflare deployment or customer acceptance.
