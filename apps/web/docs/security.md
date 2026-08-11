# Security and privacy

## Trust boundary

The account gateway terminates Better Auth sessions, approved device credentials, and scoped expert tokens. Expert-token secrets are returned once; D1 stores only their SHA-256 hashes, tenant ownership, expiry, revocation, and last-use metadata. Cloudflare Access JWT validation remains available only for owner/admin dogfood.

[`worker/src/index.ts`](../worker/src/index.ts) removes every caller-supplied trusted-context header before invoking the tenant-scoped public-review service binding or generation code. Expert tokens cannot access billing or account management, and each hosted route requires its mapped `generate:*` or `reviews:*` scope.

Unauthenticated MCP traffic is limited to `initialize`, `notifications/initialized`, `ping`, and `tools/list`. The Worker strips all caller-supplied trusted-context headers before forwarding those discovery requests. `tools/call` and every generation path require a valid tenant assertion and otherwise receive `401`, so public installation and tool discovery cannot invoke the model or consume credits.

There is no production Container. The Worker holds Cloudflare bindings and Wrangler secrets; the local Rust CLI never receives AI, D1, R2, or Stripe credentials.

## Data handling

| Data | Storage | Retention |
| --- | --- | --- |
| Prompt | Request/Workflow payload only; not D1 | Workflow execution lifetime |
| Reference image | Temporary tenant/job R2 key | Deleted in success/failure finalizer |
| Generated image | Private R2 artifact | Trial 1 day; Default 7 days; High 30 days |
| Job metadata | D1 | Operational/billing record |
| Usage event | D1 and Stripe | Billing record |
| Stripe secret/webhook secret | Wrangler secret | Until rotated |

Artifact downloads query D1 with both job ID and tenant ID before reading R2. Artifact responses are `private` and have a five-minute browser cache lifetime.

## AI privacy

Every AI call skips AI Gateway cache and requests no AI Gateway log collection. The product does not write prompts or reference bytes to its database. Provider-side processing still follows the terms of Cloudflare Unified Billing and the selected Google model; state that dependency in the public privacy policy before launch.

## Abuse controls

- Maximum three references.
- Maximum 4,000 prompt characters, 10 MiB per reference, and 20 MiB total reference bytes.
- Fixed image MIME allowlist.
- Fast is restricted to 1K.
- Per-tenant active, queued, and per-minute limits in a SQLite Durable Object.
- One trial reservation per verified identity before references or model work.
- Trial input restricted to one blocking Fast 1K image with 1-day artifact retention.
- Keyed network-cohort limit of three identities per 30 days; the source IP is not stored.
- Global limit of 50 new trial identities per UTC day.
- Production subscription gate after the trial is consumed or for Standard, Pro, and background work.
- Private artifacts and tenant-scoped keys.
- Stripe webhook HMAC verification with timestamp tolerance and event idempotency.
- Better Auth session and device credential validation.
- Expiring, revocable, tenant-bound expert-token hashes and route scope checks.
- Same-origin enforcement for cookie-backed expert-token creation and revocation.
- Cloudflare Access JWT signature, issuer, audience, expiry, and stable-claim validation for owner dogfood.

Cloudflare custom rule `8d783b50423a485fab289d93a2ad67f2` rejects mutating requests to `app.nibtool.com` when the declared `Content-Length` exceeds 28 MiB. A 29,360,129-byte production canary returned Cloudflare `403`. This is the strongest available Free-plan rule: complete edge enforcement for chunked requests without `Content-Length` requires WAF Advanced and its `http.request.body.size` field. Application-level limits remain authoritative for every request transport.
