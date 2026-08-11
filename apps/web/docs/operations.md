# Operations

## Health and canaries

| Check | Expected result |
| --- | --- |
| `GET /health` | `200` with `{ok:true, service:"nib"}` |
| Public Topcoat pages | `200`, CSP present, served by Workers Static Assets |
| Unauthenticated MCP `initialize` and `tools/list` | Success; exactly `generate_ui` |
| Unauthenticated MCP `tools/call` | Worker `401` before model work |
| Fast 1K canary | Valid image, $0.12 usage, private artifact |
| Resume completed job | Same metadata and image while retained |

## Observe

Cloudflare observability is enabled in [`wrangler.jsonc`](../wrangler.jsonc). Monitor:

- Worker 4xx/5xx by route and tenant-safe error code.
- Worker CPU time, invocation latency, and binding failures.
- Workflow retries, terminal failures, and duration by quality/resolution.
- Durable Object `RATE_LIMITED`, `CONCURRENCY_LIMIT`, and `QUEUE_FULL` results.
- Queue retries and dead-letter growth.
- D1 `usage_ledger` rows in `queued` state older than ten minutes.
- R2 artifact count by expiration day.
- AI Gateway provider errors and Unified Billing credit balance.
- `cloudflare_usage_daily` freshness and any missing cost fields from the restricted-alpha Billable Usage API.

Do not log prompts, reference data URIs, inline image base64, Stripe secrets, or Access tokens.

## Failure behavior

| Failure | Behavior | Operator action |
| --- | --- | --- |
| Model/provider transient error | Workflow retries three times with exponential backoff | Inspect AI Gateway and Workflow logs |
| Model terminal error | Job becomes `failed`; gate and references release | Confirm error class; run a 1K canary |
| Queue/Stripe error | Queue retries; daily cron reconciles unsent ledger | Inspect DLQ and Stripe response |
| Artifact expiry | Daily cron deletes R2 object and clears D1 key | No action unless cleanup falls behind |
| Canceled subscription | Webhook clears authorization | Verify webhook delivery/signature |
| Cloudflare usage sync error | Cron logs the error and leaves customer traffic unchanged | Verify API access; do not alter customer invoices |
| One plan queue empty | Scheduler uses the other plan | No action |

## Daily maintenance

At `03:17 UTC`, the scheduled handler:

1. Selects up to 500 expired artifact rows.
2. Deletes their R2 objects.
3. Clears their D1 artifact keys.
4. Requeues up to 500 unsent usage ledger rows older than five minutes.
5. If configured, fetches and replaces the previous UTC day's account-level Cloudflare usage summaries.

Implementation: [`runMaintenance`](../worker/src/generation.ts), scheduled by [`wrangler.jsonc`](../wrangler.jsonc).

## Incident rules

- Disable checkout if paid canaries fail; do not accept payment for an unavailable model path.
- Keep generation and metering facts separate: a succeeded artifact with an unsent ledger is a billing-delivery incident, not a generation failure.
- Never replay Stripe usage with a new identifier. Reuse the stored ledger identifier.
- Never make the R2 bucket public to work around artifact delivery problems.
- Never use `cloudflare_usage_daily` as a customer billing or entitlement source.
