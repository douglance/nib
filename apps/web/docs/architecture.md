# Architecture

Nib production is a Cloudflare Workers application. It does not use Cloudflare Containers, a hosted Rust server, or Browser Rendering.

## Ownership

```text
nib/
|-- src/                     Rust Incurs catalog and local CLI client
|-- patches/                 Narrow Incurs rich-MCP seam
|-- worker/src/              Worker routing, MCP, generation, policy, billing
|-- worker/migrations/       D1 schema and lifecycle migrations
|-- site/src/                Topcoat pages and Cloudflare Rust/Wasm entrypoint
|-- site/wrangler.jsonc      Internal Topcoat Worker deployment
|-- site/dist/assets/        Image and browser-script asset payload
`-- wrangler.jsonc           Worker bindings and deployment topology
```

Topcoat is a production request-time renderer. `nib-site` compiles to `wasm32-unknown-unknown` with workers-rs and calls `Router::handle` for each page request. The public `nib` Worker reaches it through the `SITE` service binding. `npm run site:build` still creates deterministic HTML snapshots for build validation and copies the image and browser script into `site/dist/assets`; production page routes do not serve those HTML snapshots. The local Rust CLI is a client and optional stdio MCP transport.

This uses Topcoat's platform-neutral Wasm/serverless path from [PR 191](https://github.com/tokio-rs/topcoat/pull/191) and its [pinned router implementation](https://github.com/tokio-rs/topcoat/blob/f267417e28b4730aee9962aa935f1b1d3837b6b7/crates/topcoat-router/src/router.rs). The native `serve` feature is disabled. workers-rs provides the standard HTTP Worker bridge described in [Cloudflare's Rust documentation](https://developers.cloudflare.com/workers/languages/rust/). The build uses worker-build's `--no-panic-recovery` mode because the optional catch-wrapper transform requires an externref table this module does not emit; an uncaught panic follows the normal Worker isolate-abort path.

## Request flow

```text
Agent or CLI
     |
     v
Cloudflare Worker
  |
  +-- public/private pages ---------> SITE service binding
  |                                      |
  |                                Topcoat Wasm Worker
  +-- /assets/* -------------------> Workers Static Assets
  +-- OpenAPI and skill discovery --> Worker responses
  +-- /mcp -------------------------> stateless MCP handler
  |                                      |
  |                                      `-- generate_ui
  +-- /internal/v1/generate -------------+
  |                                      |
  |                               identity + plan gate
  |                                      |
  |                         +------------+------------+
  |                         |                         |
  |                      blocking               background
  |                         |                    Scheduler DO
  |                         +----------> Workflow <---+
  |                                      |
  |                           Workers AI + AI Gateway
  |                                      |
  |                             Gemini image model
  |                                      |
  |                         R2 artifact + D1 ledger
  |                                      |
  |                              Queue -> Stripe meter
  |
  `-- billing routes ----------------> Stripe API/webhook
```

Public MCP initialization and tool discovery do not require an identity. A `generate_ui` call reaches the same Worker-native generation function as `/internal/v1/generate` and requires a trusted tenant. The Worker removes caller-supplied trusted-context headers before deriving that tenant.

## Cloudflare services

| Service | Responsibility | Code/config |
| --- | --- | --- |
| Public Worker | Routing, stateless MCP, identity propagation, generation entrypoint, billing, maintenance | [`worker/src/index.ts`](../worker/src/index.ts), [`worker/src/mcp.ts`](../worker/src/mcp.ts) |
| Topcoat Worker | Dynamic Rust/Wasm page rendering through `Router::handle` | [`site/src/lib.rs`](../site/src/lib.rs), [`site/wrangler.jsonc`](../site/wrangler.jsonc) |
| Service Bindings | Private Worker-to-Worker page routing without a public Topcoat origin | [`wrangler.jsonc`](../wrangler.jsonc), [Cloudflare documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) |
| Workers Static Assets | Generated hero image and installation browser script | [`site/src`](../site/src), [`wrangler.jsonc`](../wrangler.jsonc) |
| Zero Trust Access | Owner/admin authentication; not the customer identity system | [`worker/src/access.ts`](../worker/src/access.ts), external config |
| Workers AI | Provider-keyless model invocation | [`worker/src/generation.ts`](../worker/src/generation.ts) |
| AI Gateway | Unified Billing and request policy with prompt logging disabled | [`worker/src/generation.ts`](../worker/src/generation.ts) |
| Durable Objects | Per-tenant limits, trial abuse limits, and weighted scheduling | [`tenant-gate.ts`](../worker/src/tenant-gate.ts), [`trial.ts`](../worker/src/trial.ts), [`scheduler.ts`](../worker/src/scheduler.ts) |
| Workflows | Durable background generation and retry | [`worker/src/generation.ts`](../worker/src/generation.ts) |
| D1 | Accounts, jobs, usage ledger, webhook idempotency, account-usage summaries | [`worker/migrations`](../worker/migrations) |
| R2 | Temporary references and private retained artifacts | [`worker/src/generation.ts`](../worker/src/generation.ts) |
| Queues | Stripe meter delivery and retry | [`worker/src/billing.ts`](../worker/src/billing.ts) |
| Cron Triggers | Expiry cleanup, Stripe usage reconciliation, optional account-usage sync | [`wrangler.jsonc`](../wrangler.jsonc) |
| Observability | Worker logs and traces | [`wrangler.jsonc`](../wrangler.jsonc) |

Cloudflare Unified Billing lets the Workers AI binding call supported third-party models without storing a Google provider key. See [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) and the [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).

The optional [Billable Usage API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get/) sync is internal account telemetry. It is not a payment processor, customer meter, entitlement source, or replacement for Stripe.

## Data boundaries

- Prompts exist in request and Workflow payload memory but are not written to D1.
- References use tenant/job-scoped temporary R2 keys and are deleted by success and failure finalizers.
- Generated artifacts are private, tenant-checked, and expire after 1 day for trial users, 7 days on Default, or 30 days on High.
- Trial abuse state stores a keyed IPv4 `/24` or IPv6 `/64` cohort hash instead of the source IP address.
- D1 retains job metadata and billed usage, not image bytes or prompts.
- AI Gateway request/response logging is disabled with `collectLog: false`; every generation skips cache.

## Source-of-truth rule

The Rust Incurs command catalog owns the CLI field names, defaults, descriptions, and examples. The Worker-native MCP exposes the same single `generate_ui` operation, and the Worker revalidates all security-sensitive fields at the billing boundary. The Topcoat page describes the contract but does not define it.
