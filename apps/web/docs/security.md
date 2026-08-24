# Security and privacy

## Trust boundary

The public Worker authenticates one passwordless email account. A one-time email link verifies the address; PKCE binds the link to the initiating client. D1 stores hashed challenges and session tokens, and every product record is keyed by a UUID account ID. The public Worker strips caller-supplied trusted headers before forwarding review traffic through the private `REVIEW` service binding.

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
| Magic-link challenge | D1, token hashed | 10 minutes; one use |
| Account session | D1, token hashed; client token in cookie or Keychain | Until sign-out or revocation |
| Account identity | D1 UUID and verified email | Until account deletion |
| Review files, history, and devices | Account Durable Object and private R2 objects | Until account deletion |
| Stripe secret/webhook secret | Wrangler secret | Until rotated |

Artifact downloads query D1 with both job ID and tenant ID before reading R2. Artifact responses are `private` and have a five-minute browser cache lifetime.

Account deletion removes billing access before product data. It deletes the Stripe customer, writes a non-personal UUID deletion tombstone, purges account-scoped R2 prefixes and Durable Object state, removes authentication and product rows, and expires the current cookie or Keychain credential. The review Durable Object retains only a deletion tombstone so late requests cannot recreate data under the deleted account ID.

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
- One-time email challenge, PKCE verification, hashed session token, and explicit revocation.

Before launch, add a Cloudflare WAF request-body rule aligned with these application limits so oversized requests are rejected before Worker execution.
