# Billing and limits

## Plans

| Plan | Monthly | Active | Queued | Requests/min | Retention | Scheduler weight |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Default | $9.99 | 2 | 20 | 60 | 7 days | 1 |
| High | $29.99 | 8 | 100 | 300 | 30 days | 4 |

Subscriptions do not include usage credits or a usage cap. Both plans have the same per-image rates. Limits are enforced by [`worker/src/tenant-gate.ts`](../worker/src/tenant-gate.ts); the canonical plan table is [`worker/src/rate-card.ts`](../worker/src/rate-card.ts).

Operator-owned accounts may be granted `unmetered_access`. They bypass the subscription and Stripe usage-meter paths while retaining the selected plan's concurrency, queue, rate, and retention limits.

## Free trial

An eligible Nib account receives one blocking Fast 1K image without a card. Trial artifacts expire after 1 day. Trial generations do not create Stripe meter events.

The Worker permits at most three distinct trial identities from one keyed IPv4 `/24` or IPv6 `/64` network cohort during any 30-day window. It also admits at most 50 new trial identities per UTC day. The keyed cohort hash is stored in the `TrialGate` Durable Object; the source IP address is not stored. A failed model request releases the identity's image reservation so the same identity can retry, but it does not create another network claim.

## Usage rates

| Preset | Cloudflare model | 1K | 2K | 4K |
| --- | --- | ---: | ---: | ---: |
| Fast | `google/nano-banana-2-lite` | $0.12 | unsupported | unsupported |
| Standard | `google/nano-banana-2` | $0.22 | $0.32 | $0.48 |
| Pro | `google/nano-banana-pro` | $0.43 | $0.43 | $0.75 |

The service records usage only after a successful image fetch and R2 write. `usage_cents` is a whole-number Stripe meter value. `STRIPE_USAGE_EVENT_NAME` must match the event name of the meter attached to `USAGE_PRICE_ID`. The existing live meter accepts `visualize_usage_cents`; that identifier is retained even though the customer-facing product is named Nib Cloud Usage. Missing configuration leaves messages queued for retry without sending usage or marking it delivered.

## Stripe objects

The live Stripe account contains:

1. A `$9.99/month` recurring Default price.
2. A `$29.99/month` recurring High price.
3. An active meter accepting `visualize_usage_cents` with sum aggregation.
4. A metered recurring price attached to that meter, with a one-cent unit amount.
5. A Nib-specific Customer Portal configuration for cancellation, invoices, and payment details.

Portal sessions explicitly select `STRIPE_PORTAL_CONFIGURATION_ID`; the shared Stripe account's default portal belongs to another product. Nib's live configuration is `bpc_1U3InjGHuCWtbWKO5bH7t1qe`, with canonical `nibtool.com` return, privacy, and terms links. HTML form requests redirect to Stripe; JSON clients receive the session object.

Stripe's portal cannot update subscriptions with usage-based billing or multiple products. Plan switching uses Nib's authenticated `POST /billing/plan` API and still needs a visible account-page control. Do not describe portal plan switching as available for Nib. See [Stripe's portal limitations](https://docs.stripe.com/customer-management).

### Account-page API contract

The plan-switching account-page design is awaiting approval. The supporting form and private-status APIs are deployed; this does not make the unfinished page a complete self-service billing interface.

`GET /billing/status` uses the verified session's account ID, never a caller-selected account. It returns `{subscribed: boolean, plan: "default" | "high", hasBillingCustomer: boolean}` with `Cache-Control: private, no-store`. `subscribed: false` must not be presented as a paid subscription even if the saved `plan` value is Default or High. `hasBillingCustomer` lets former subscribers access invoices and payment details after cancellation; it must not grant generation access. Deleted accounts return 404; unauthenticated requests return 401. This is the latest reconciled entitlement, not a fresh Stripe query.

`POST /billing/plan` accepts the existing JSON `{plan: "default" | "high"}` contract and HTML form data with the same `plan` field. JSON clients retain the Stripe response. The handler changes only the existing recurring item, leaves metered usage attached, and requests proration on the next invoice. It does not grant local access before webhook reconciliation.

For clients accepting HTML, the handler redirects with 303 to `/account` and these bounded outcome parameters:

| `plan_change` | Meaning | Account-page behavior |
| --- | --- | --- |
| `submitted` | Stripe accepted the update; `plan` contains the requested plan. | Refresh billing status; do not infer confirmed access from the query string. |
| `invalid` | The submitted plan or request body was invalid. | Ask the user to select a supported plan. |
| `no_subscription` | No active subscription/item is attached to the account. | Offer subscription checkout, not another plan mutation. |
| `failed` | Stripe rejected the mutation with a non-server error. | Show a recoverable error without claiming the plan changed. |
| `unknown` | The connection failed or Stripe returned a server error; the update may have happened. | Check current status before suggesting another submission. |

The handler never automatically retries a plan mutation after an ambiguous response. Status-query failure is also not evidence of subscription cancellation; the UI must show an unavailable state rather than replacing it with an unsubscribed state.

Checkout contains the selected recurring price and the shared metered price. It collects the customer's name, billing address, and supported tax ID, and enables Stripe Tax automatic calculation. A returning tenant reuses its existing Stripe customer so Checkout can update the saved name and billing address instead of creating a duplicate customer.

Stripe subscription metadata carries `account_id` and `plan`. The Worker verifies webhook signatures and reconciles the customer's current Stripe subscriptions instead of applying event snapshots in delivery order. Only an `active` or `trialing` subscription with the configured monthly and metered usage prices grants access; the paid price determines the plan. A delayed checkout cannot restore canceled access or undo a plan change, and cancellation of an old subscription cannot revoke its active replacement.

The access update and processed event ID commit together in a D1 batch. Migration `0013_billing_reconciliation.sql` adds the account's last billing-event marker. If another event changes that marker while Stripe is being read, the stale reconciliation fails and Stripe retries it against fresh state. Provider or database failures leave the event unprocessed. Plan-change requests update Stripe; the resulting webhook owns the local access change. Source: [`worker/src/billing-webhook.ts`](../worker/src/billing-webhook.ts).

The production restricted key needs subscription read access for reconciliation and write access for the mutations below:

| Stripe endpoint | Worker action |
| --- | --- |
| `/v1/checkout/sessions` | Create a subscription checkout session. |
| `/v1/billing_portal/sessions` | Create a customer portal session. |
| `/v1/subscriptions/{id}` | Change the recurring plan price. |
| `GET /v1/subscriptions` | Reconcile the customer's current subscriptions across all pages. |
| `/v1/billing/meter_events` | Send successful image usage. |
| `/v1/customers/{id}` | Delete the Stripe customer and cancel active billing before account deletion. |

Create the key in the Stripe Dashboard, then store it only as the Cloudflare Worker secret `STRIPE_SECRET_KEY`. Do not use the 90-day key generated by `stripe login` for production.

Account deletion calls Stripe first. If Stripe cannot confirm customer deletion, Nib leaves the account and product data intact so the user can retry without losing access while billing continues.

## Meter delivery

```text
successful job
   |
   v
D1 INSERT OR IGNORE usage_ledger
   |
   v
Cloudflare Queue
   |
   v
Stripe /v1/billing/meter_events
   |
   v
D1 state = sent
```

The event identifier is `nib_<job-id>`, so Queue retries and scheduled reconciliation cannot create a second logical event. The daily cron requeues ledger rows still in `queued` state after five minutes. Stripe's endpoint and identifier semantics are documented in the [meter event API](https://docs.stripe.com/api/billing/meter-event/create).

Before the first Stripe request, the Queue consumer freezes the meter event name, Stripe customer, usage value, event timestamp, and first-attempt time onto the `usage_ledger` row. Later Queue deliveries ignore the message's customer and value fields and replay the stored payload with the same Stripe `Idempotency-Key`. Rows already marked `sent` are acknowledged without another Stripe call.

If a first attempt is older than the Stripe idempotency and identifier safety window, or Stripe reports that the identifier already exists outside the cached response path, Nib leaves the row in `queued` state with `reconciliation_required = 1`. Cron excludes those rows; an operator must compare the ledger row with Stripe meter summaries or invoices before marking it sent or retrying it with a new action.

## Webhooks

Subscribe the production endpoint `/billing/webhook` to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

The webhook route intentionally bypasses Access and relies on the Stripe HMAC signature with a five-minute timestamp tolerance.

## Cloudflare cost telemetry

The daily cron can query Cloudflare's restricted-alpha [Billable Usage API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get/) for the previous complete UTC day. It summarizes records by date, product family, billable metric, and unit in the D1 `cloudflare_usage_daily` table.

This telemetry is account-level and never determines a customer's invoice or entitlement. Cloudflare currently warns that cost and pricing fields may be absent. Missing cost fields are stored as `NULL`, and a failed or unconfigured sync does not interrupt generation, artifact cleanup, or Stripe reconciliation.
