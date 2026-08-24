# Deployment

The canonical production origin is `https://nibtool.com`. Nib has one passwordless account system and no legacy customer migration path.

| Launch requirement | Current state | Required result |
| --- | --- | --- |
| Account authentication | Passwordless email challenge, PKCE, revocable sessions, and UUID account ownership are deployed. | Keep the email sender and rate-limit secret configured. |
| Stripe API key | A live restricted key is deployed. | Verify checkout whenever the key or price configuration changes. |
| Billable Usage API | Optional: restricted alpha; current Wrangler OAuth grant has no billing permission. | Add a read-only API token only when Cloudflare grants account access. Customer billing does not depend on it. |

Protected execution fails closed without a valid Nib account session.

## 1. Cloudflare resources

The production account contains the required D1 database, R2 buckets, and Queues. Use these commands only when recreating an environment:

```sh
npx wrangler d1 create nib
npx wrangler r2 bucket create nib-artifacts
npx wrangler r2 bucket create nib-artifacts-preview
npx wrangler queues create nib-metering
npx wrangler queues create nib-metering-dlq
```

Put the returned D1 database ID in `wrangler.jsonc`. Static assets, the internal Topcoat service binding, Durable Objects, Workflow, cron, bindings, migrations, and Queue consumers are declared there. The Topcoat Worker is declared separately in `site/wrangler.jsonc` and must be deployed first.

## 2. Configure AI Gateway

1. Keep `AI_GATEWAY_ID` set to `default`. Cloudflare creates the default gateway on the first authenticated binding request.
2. Enable [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) and fund Cloudflare credits.
3. Confirm the gateway can invoke the Google models in [`worker/src/rate-card.ts`](../worker/src/rate-card.ts).
4. Leave request/response logging disabled; the generation call also sends `collectLog: false` and `skipCache: true`.

The current model input shapes come from Cloudflare's [Nano Banana 2](https://developers.cloudflare.com/ai/models/google/nano-banana-2/) and [Nano Banana Pro](https://developers.cloudflare.com/ai/models/google/nano-banana-pro/) schemas. Run a paid 1K canary before opening checkout because provider/model availability can change.

## 3. Configure Stripe

The live Stripe account contains the products, prices, meter, and webhook described in [`billing.md`](billing.md). The deployed price IDs are in `wrangler.jsonc`; the canonical webhook target is `https://nibtool.com/billing/webhook`.

Create and rotate the live restricted key on the [Stripe API keys page](https://dashboard.stripe.com/apikeys) with only the permissions required by [`billing.md`](billing.md). Stripe displays the key once. Paste it directly into Wrangler; do not save it in the repository or send it through chat:

```sh
npx wrangler secret put STRIPE_SECRET_KEY
```

The production Worker already has `STRIPE_WEBHOOK_SECRET`. Replace it only when rotating or recreating the webhook endpoint.

Enable Stripe Tax and complete the business-origin and tax-registration settings on the [Stripe Tax settings page](https://dashboard.stripe.com/settings/tax) before relying on automatic tax calculation. Checkout requests the customer's name, billing address, and supported tax ID; Stripe decides whether tax can be calculated and collected for the configured registrations.

## 4. Configure authentication

`PUBLIC_ORIGIN` is fixed to `https://nibtool.com`. Configure `AUTH_RATE_LIMIT_SECRET` as a Wrangler secret and verify `login@nibtool.com` is an allowed Cloudflare Email Service sender. Apply migrations through `0010_hard_cut_accounts.sql` before deploying the Worker. Migration 0010 deletes pre-launch test identities and drops the superseded auth and workspace schemas. Public discovery remains unauthenticated; product data and execution require a revocable account session.

## 5. Apply D1 migrations

```sh
npx wrangler d1 migrations apply nib --remote
```

Migrations `0003_artifact_expiry.sql` and `0004_free_trial.sql` are required before generation. Migration `0004` adds trial reservation state and the job billing mode. Migration `0005_cloudflare_usage.sql` adds internal account-usage summaries and does not affect customer traffic.

## 6. Optional Cloudflare account-usage sync

Cloudflare labels `GET /accounts/{account_id}/billable/usage` as restricted alpha and warns that cost fields may be absent. Do not block launch on this integration.

When the account has access, create a read-only API token that can call the Billable Usage endpoint, then store it without writing it to the repository or chat:

```sh
npx wrangler secret put CLOUDFLARE_BILLING_API_TOKEN
```

`CLOUDFLARE_ACCOUNT_ID` is already configured in `wrangler.jsonc`. The daily cron skips the sync when the secret is absent and logs an error without failing maintenance when the API rejects or fails the request.

## 7. Verify locally and build

```sh
cargo test
npm run site:build
npm run site:worker:build
npm run check
npm test
(cd site && cargo check)
npx wrangler deploy --config site/wrangler.jsonc --dry-run
npx wrangler deploy --dry-run
```

The local CLI uses the patched sibling Incurs checkout declared in [`Cargo.toml`](../Cargo.toml). The Topcoat crate is pinned by git revision in [`site/Cargo.toml`](../site/Cargo.toml). `npm run site:worker:build` builds the dynamic Topcoat Wasm Worker. `npm run site:build` validates deterministic page rendering and copies the hero image and installation script into `site/dist/assets` for the public Worker's `ASSETS` binding. Only that asset subdirectory is uploaded; exported HTML is never part of the production asset manifest.

## 8. Deploy and canary

```sh
npm run deploy
```

`npm run deploy` builds the asset snapshot, deploys `nib-site`, then deploys `nib` with its `SITE` service binding. The site Worker has `workers_dev = false`, so it is reachable only through bindings such as `SITE`.

Verify, in order:

1. Public `/health`, `/`, `/docs`, and `/pricing` responses; page responses include `x-nib-renderer: topcoat-wasm-worker`.
2. Unauthenticated MCP `initialize` and `tools/list` succeed and return only `generate_ui`.
3. An unauthenticated MCP `tools/call` cannot invoke generation.
4. One verified unsubscribed identity receives one Fast 1K image, then receives `FREE_TRIAL_USED` on a second generation.
5. A fourth trial identity in one network cohort receives `FREE_TRIAL_NETWORK_LIMIT`.
6. One paid Fast 1K generation creates a D1 usage row and exactly one Stripe `nib_usage_cents` meter event.
7. Default-to-High change and cancellation update authorization correctly.

The 2026-08-13 production canary created a live-mode $9.99 default-plan Checkout Session through an authenticated Nib account, with automatic tax, billing address, tax ID, and individual-name collection enabled. The same canary account was then permanently deleted through `DELETE /api/account`.

## Rollback

If a page canary fails, roll back both Workers to the last compatible pair: the public Worker first, then the Topcoat Worker. For other failures, roll back the affected Worker deployment and inspect Worker, Workflow, Durable Object, and Queue logs before retrying. Static assets are versioned with the public Worker deployment. D1 migrations are forward-only; do not delete new columns during an application rollback.
