# Deployment

The production Worker targets `https://app.nibtool.com` in the `doug-lance.workers.dev` Cloudflare account. The site, account flow, OpenAPI, skill discovery, remote MCP, generation, reviews, and billing share that origin.

| Launch requirement | Current state | Required result |
| --- | --- | --- |
| Owner/admin authentication | Better Auth account sessions and device authorization are implemented; optional Cloudflare Access remains available for dogfood. | Verify email delivery, passkeys, device approval, and logout on the production origin. |
| Expert automation | Scoped, expiring, revocable expert tokens are stored as hashes in D1. | Canary create, reveal-once, read/write scope denial, revoke, and post-revoke rejection. |
| Stripe API key | A durable live restricted key is deployed with write access to Billing Meter Events, Customer Portal, Subscriptions, and Checkout Sessions. Permission canaries reached parameter validation for all four write APIs; unrelated Charges and Customers reads returned Stripe `403 more_permissions_required`. | Rotate the key through Stripe and update the encrypted `STRIPE_SECRET_KEY` Worker secret as one operation. |
| WAF request-body rule | The active `Reject oversized Nib request bodies` rule blocks mutating requests whose `Content-Length` exceeds 28 MiB; a 29,360,129-byte production canary returned Cloudflare `403`. | Upgrade to WAF Advanced if edge enforcement must also cover chunked requests without `Content-Length`; the Free plan does not expose `http.request.body.size`. |
| Billable Usage API | Optional: restricted alpha; current Wrangler OAuth grant has no billing permission. | Add a read-only API token only when Cloudflare grants account access. Customer billing does not depend on it. |

Do not onboard customers or run a live checkout until the authentication and billing canaries have the required result.

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

The live Stripe account contains the products, prices, meter, and webhook described in [`billing.md`](billing.md). The deployed price IDs are in `wrangler.jsonc`, and the webhook targets `https://app.nibtool.com/billing/webhook`.

Production uses a durable live restricted key with only the permissions required by [`billing.md`](billing.md). Stripe displays replacement keys once. During rotation, paste the replacement directly into Wrangler; do not save it in the repository or send it through chat:

```sh
npx wrangler secret put STRIPE_SECRET_KEY
```

The production Worker already has `STRIPE_WEBHOOK_SECRET`. Replace it only when rotating or recreating the webhook endpoint.

Enable Stripe Tax and complete the business-origin and tax-registration settings on the [Stripe Tax settings page](https://dashboard.stripe.com/settings/tax) before relying on automatic tax calculation. Checkout requests the customer's name, billing address, and supported tax ID; Stripe decides whether tax can be calculated and collected for the configured registrations.

## 4. Configure authentication

`PUBLIC_ORIGIN` is set to the production Worker origin. Keep these identity scopes separate:

| Scope | Mechanism | Status |
| --- | --- | --- |
| Customer browser | Better Auth magic link, passkey, and session cookie | Implemented; requires production email and live canary |
| CLI and native apps | Better Auth device authorization and bearer credential | Implemented; requires platform build and live canary |
| CI, scripts, remote MCP | Scoped expert token | Implemented; requires live scope and revocation canary |
| Owner/admin dogfood | Cloudflare Zero Trust Access | Optional compatibility path in [`worker/src/access.ts`](../worker/src/access.ts) |

For owner/admin Access, create a self-hosted application for protected routes, keep the public site, discovery, `/mcp`, and `/billing/webhook` outside it, then set `ACCESS_TEAM_DOMAIN` and `ACCESS_POLICY_AUD`. The Worker validates the assertion itself before an MCP `tools/call`. See [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

Do not add customers as Zero Trust users. Public discovery cannot execute a model. Customer sessions and device credentials are tenant-bound through the account database; expert tokens are tenant-bound, scoped, expiring, revocable, and stored only as hashes.

## 5. Apply D1 migrations

```sh
npx wrangler d1 migrations apply nib --remote
```

Migrations through `0008_auth_rate_limit.sql` are required. Migration `0006` adds accounts, Better Auth, workspaces, and memberships. Migration `0007` adds scoped expert-token lifecycle state. Migration `0008` adds persistent Better Auth rate-limit state.

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

The 2026-08-11 deployment produced this compatible version set:

| Worker | Version |
| --- | --- |
| `nib-global` | `82a6416d-074b-402e-bf26-a680e7b6e678` |
| `nib-site` | `ef7b6c5d-0446-4176-b9a8-ca6686c62d5b` |
| `nib` | `4474d34a-9103-4ad5-b01d-dc0a3a8abc6e` |
| `nib-codemode-global` | `0e591f25-3ee1-4ee6-99f3-ecd6b81b916d` |

Live checks passed for `/health`, `/`, `/docs`, and `/pricing`; all three rendered pages returned `x-nib-renderer: topcoat-wasm-worker`. Unauthenticated MCP `initialize` and `tools/list` succeeded, and unauthenticated `tools/call` returned `401`. The public `nib-global` network endpoint remains service-authenticated and returns `401` without a credential. After the durable Stripe key rotation, Worker version `4474d34a-9103-4ad5-b01d-dc0a3a8abc6e` returned `{"ok":true,"service":"nib"}` from production `/health`. Direct Stripe canaries reached parameter validation for each required write API, while unrelated Charges and Customers reads were denied with `403 more_permissions_required`.

Code Mode has a real review-only portal credential with `reviews:read,reviews:write`; its production `/health` returned `200` with `portalAuth: "expert-token"`. The Cloudflare custom rule `8d783b50423a485fab289d93a2ad67f2` is active for `app.nibtool.com` and rejects declared request bodies over 28 MiB before Worker execution. Because `http.request.body.size` requires WAF Advanced, the current Free-plan rule compares `Content-Length` and does not cover chunked requests that omit that header. Customer authentication, token revocation, paid generation, checkout, portal, usage metering, and plan-change canaries remain required before onboarding customers.

The last verified pre-launch renderer/public pair remains `182e5669-4fb5-428b-a378-19cf19f0c783` and `3f9d10ef-6600-4b78-acfd-d82c7b9af77f`. No Nib Container application exists.

## Rollback

If a page canary fails, roll back both Workers to the last compatible pair: the public Worker first, then the Topcoat Worker. For other failures, roll back the affected Worker deployment and inspect Worker, Workflow, Durable Object, and Queue logs before retrying. Static assets are versioned with the public Worker deployment. D1 migrations are forward-only; do not delete new columns during an application rollback.
