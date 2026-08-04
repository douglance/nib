# Deployment

The production Worker is deployed at `https://visualize.doug-lance.workers.dev` in the `doug-lance.workers.dev` Cloudflare account. The site, OpenAPI, skill discovery, and remote MCP discovery are live. Customer generation and checkout remain closed until scalable customer authentication is implemented and canaried.

| Launch requirement | Current state | Required result |
| --- | --- | --- |
| Owner/admin authentication | One Cloudflare Zero Trust Standard seat is available. Protected routes currently fail closed with `401` because the Worker Access variables are empty. | Configure Access for owner/admin dogfood only. |
| Customer authentication | Not implemented. A Zero Trust seat is consumed by each Access user, so the single Standard seat cannot be the customer identity system. | Implement and canary customer signup plus revocable Worker credentials before accepting customers. |
| Stripe API key | A temporary Stripe CLI live key is deployed. | Replace `STRIPE_SECRET_KEY` with a durable live restricted key before accepting customers. |
| Billable Usage API | Optional: restricted alpha; current Wrangler OAuth grant has no billing permission. | Add a read-only API token only when Cloudflare grants account access. Customer billing does not depend on it. |

Do not onboard customers or run a live checkout until customer authentication and the Stripe key have the required result. Publishing the pricing page and public agent-discovery surfaces is safe while protected execution fails closed.

## 1. Cloudflare resources

The production account contains the required D1 database, R2 buckets, and Queues. Use these commands only when recreating an environment:

```sh
npx wrangler d1 create visualize
npx wrangler r2 bucket create visualize-artifacts
npx wrangler r2 bucket create visualize-artifacts-preview
npx wrangler queues create visualize-metering
npx wrangler queues create visualize-metering-dlq
```

Put the returned D1 database ID in `wrangler.jsonc`. Static assets, the internal Topcoat service binding, Durable Objects, Workflow, cron, bindings, migrations, and Queue consumers are declared there. The Topcoat Worker is declared separately in `site/wrangler.jsonc` and must be deployed first.

## 2. Configure AI Gateway

1. Keep `AI_GATEWAY_ID` set to `default`. Cloudflare creates the default gateway on the first authenticated binding request.
2. Enable [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) and fund Cloudflare credits.
3. Confirm the gateway can invoke the Google models in [`worker/src/rate-card.ts`](../worker/src/rate-card.ts).
4. Leave request/response logging disabled; the generation call also sends `collectLog: false` and `skipCache: true`.

The current model input shapes come from Cloudflare's [Nano Banana 2](https://developers.cloudflare.com/ai/models/google/nano-banana-2/) and [Nano Banana Pro](https://developers.cloudflare.com/ai/models/google/nano-banana-pro/) schemas. Run a paid 1K canary before opening checkout because provider/model availability can change.

## 3. Configure Stripe

The live Stripe account contains the products, prices, meter, and webhook described in [`billing.md`](billing.md). The deployed price IDs are in `wrangler.jsonc`, and the webhook targets `https://visualize.doug-lance.workers.dev/billing/webhook`.

Before launch, create a durable live restricted key on the [Stripe API keys page](https://dashboard.stripe.com/apikeys) with only the permissions required by [`billing.md`](billing.md). Stripe displays the key once. Paste it directly into Wrangler; do not save it in the repository or send it through chat:

```sh
npx wrangler secret put STRIPE_SECRET_KEY
```

The production Worker already has `STRIPE_WEBHOOK_SECRET`. Replace it only when rotating or recreating the webhook endpoint.

Enable Stripe Tax and complete the business-origin and tax-registration settings on the [Stripe Tax settings page](https://dashboard.stripe.com/settings/tax) before relying on automatic tax calculation. Checkout requests the customer's name, billing address, and supported tax ID; Stripe decides whether tax can be calculated and collected for the configured registrations.

## 4. Configure authentication

`PUBLIC_ORIGIN` is already set to the production Worker origin. Keep these two identity scopes separate:

| Scope | Mechanism | Status |
| --- | --- | --- |
| Owner/admin dogfood | Cloudflare Zero Trust Access | Supported by [`worker/src/access.ts`](../worker/src/access.ts); application and Wrangler variables still need configuration |
| Customers and free trials | Customer signup plus revocable Worker credentials | Not implemented; required before launch |

For owner/admin Access, create a self-hosted application for protected routes, keep the public site, discovery, `/mcp`, and `/billing/webhook` outside it, then set `ACCESS_TEAM_DOMAIN` and `ACCESS_POLICY_AUD`. The Worker validates the assertion itself before an MCP `tools/call`. See [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

Do not add customers as Zero Trust users. Each Access user consumes a seat. The customer flow must issue a tenant-bound, revocable credential that the CLI and remote MCP can present without exposing an owner service token. Store only a credential hash and lifecycle metadata in D1, use Cloudflare-native abuse controls at signup, and preserve the current rule that public discovery cannot execute a model. Until that flow exists, the Worker must continue returning `401` for customer generation, account, artifact, and billing requests.

## 5. Apply D1 migrations

```sh
npx wrangler d1 migrations apply visualize --remote
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

`npm run deploy` builds the asset snapshot, deploys `visualize-topcoat`, then deploys `visualize` with its `SITE` service binding. The site Worker has `workers_dev = false`, so it is reachable only through bindings such as `SITE`.

Verify, in order:

1. Public `/health`, `/`, `/docs`, and `/pricing` responses; page responses include `x-visualize-renderer: topcoat-wasm-worker`.
2. Unauthenticated MCP `initialize` and `tools/list` succeed and return only `generate_ui`.
3. An unauthenticated MCP `tools/call` cannot invoke generation.
4. One verified unsubscribed identity receives one Fast 1K image, then receives `FREE_TRIAL_USED` on a second generation.
5. A fourth trial identity in one network cohort receives `FREE_TRIAL_NETWORK_LIMIT`.
6. One paid Fast 1K generation creates a D1 usage row and exactly one Stripe `visualize_usage_cents` meter event.
7. Default-to-High change and cancellation update authorization correctly.

The 2026-08-04 Workers-only deployment verified dynamic Topcoat rendering on `/`, `/docs`, and `/pricing` through the `SITE` binding, asset-only Static Assets, Worker-native MCP initialization and `tools/list`, and the unauthenticated `401` account boundary. The live Topcoat Worker version is `182e5669-4fb5-428b-a378-19cf19f0c783`; the compatible public Worker version is `3f9d10ef-6600-4b78-acfd-d82c7b9af77f`. No Visualize Container application exists. Successful generation and billing canaries still require customer authentication and a durable Stripe key.

## Rollback

If a page canary fails, roll back both Workers to the last compatible pair: the public Worker first, then the Topcoat Worker. For other failures, roll back the affected Worker deployment and inspect Worker, Workflow, Durable Object, and Queue logs before retrying. Static assets are versioned with the public Worker deployment. D1 migrations are forward-only; do not delete new columns during an application rollback.
