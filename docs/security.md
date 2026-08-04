# Security and privacy

## Trust boundary

The current image-execution boundary verifies Cloudflare Access assertions. [`worker/src/access.ts`](../worker/src/access.ts) validates `Cf-Access-Jwt-Assertion` with the team JWKS, issuer, and application audience. Interactive users are keyed by the verified `email` claim; service tokens are keyed by their verified `common_name` client ID. [`worker/src/index.ts`](../worker/src/index.ts) removes any inbound `x-visualize-tenant` header and replaces it with the verified identity before invoking Worker-native MCP or generation code.

Cloudflare Zero Trust is reserved for owner/admin and dogfood access. The current Standard seat is not a scalable customer identity system. Customer generation must remain closed until a separate customer sign-up and credential flow is implemented and tested.

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
- Cloudflare Access JWT signature, issuer, audience, expiry, and stable-claim validation.

Before launch, add a Cloudflare WAF request-body rule aligned with these application limits so oversized requests are rejected before Worker execution.
