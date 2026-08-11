# Nib

Nib gives AI agents one missing capability: generate a user-interface image from a text brief and up to three reference images. Use it when an agent can describe a dashboard, settings screen, mobile app, landing page, or another interface but cannot create the image itself.

The production origin is <https://app.nibtool.com>. OpenAPI, remote MCP discovery, and the installable skill are public. Account, device, and scoped expert credentials protect generation, reviews, and billing. See [`docs/deployment.md`](docs/deployment.md).

It does not review, score, compare, capture, annotate, or approve an existing interface. The Rust CLI is the source of truth. Incurs projects the same command into CLI, Streamable HTTP MCP, HTTP, OpenAPI, and an installable skill.

## Install from an agent

Paste this prompt into Codex, Claude Code, Gemini CLI, or another coding agent:

```text
Install Nib for me. Follow https://app.nibtool.com/install-agent.md exactly. Configure it globally for this agent, install the Nib UI image skill globally, add the managed Nib instruction to this agent's global instruction file, preserve my existing settings, and verify that the generate_ui tool is available without generating an image.
```

[`/install-agent.md`](https://app.nibtool.com/install-agent.md) is the canonical host-aware installation contract. It configures only the active agent, installs the remote-MCP skill at user scope, adds one idempotent managed block to the host's global instruction file, and verifies `tools/list` without consuming the free image. The separate generated CLI skill remains available at `/.well-known/skills/generate/SKILL.md` for installations that include the `nib` binary.

```sh
nib generate "A compact dark analytics dashboard for a fleet operator" \
  --quality fast \
  --resolution 1K \
  --aspect 16:9 \
  --image-format png \
  --output dashboard.png
```

## Product contract

| Surface | Contract |
| --- | --- |
| CLI | One `generate` command |
| MCP | Public initialization and `tools/list`; authenticated `generate_ui` calls include an MCP image block |
| Inputs | One brief, zero to three PNG/JPEG/WebP references |
| Outputs | One image, structured metadata, and a private retained artifact URL |
| Models | Gemini image models through Cloudflare AI Gateway Unified Billing |
| Free trial | One blocking Fast 1K image per eligible verified identity; no card |
| Plans | Default `$9.99/month`; High `$29.99/month`; generation usage is metered separately |

The executable catalog lives in [`src/catalog.rs`](src/catalog.rs). Request validation and model/rate mappings live in [`src/domain.rs`](src/domain.rs) and [`worker/src/rate-card.ts`](worker/src/rate-card.ts).

## Architecture

```text
Agent / CLI
     |
     v
Cloudflare Worker
  |-- service binding -> Topcoat Rust/Wasm Worker
  |-- Worker Assets <- images and browser scripts
  |-- stateless Streamable HTTP MCP
  |-- OpenAPI and installable skill
  |-- identity, trial, and subscription gates
  |-- blocking generation or DO scheduler -> Workflow
  |-- Workers AI -> AI Gateway -> Gemini image model
  |-- R2 private artifact + D1 usage ledger
  `-- Queue -> Stripe meter event
```

Production uses Cloudflare Workers only. A Rust/Wasm Worker runs Topcoat's serverless router for every sales and documentation page request. The public TypeScript Worker calls it through a service binding and serves only image and browser-script files from Workers Static Assets. The public Worker owns remote MCP and all server-side product behavior through Workers AI and AI Gateway, Durable Objects, Workflows, Queues, D1, R2, cron maintenance, and observability. Stripe is the card, subscription, tax, and usage-invoice rail. The optional Cloudflare Billable Usage sync is internal account telemetry only. See [`docs/architecture.md`](docs/architecture.md).

## Local development

Requirements: Rust 1.88 for the CLI, Rust 1.95 for the current Topcoat site, Node 22+, and Wrangler 4.118.

```sh
npm install
cargo test
npm run site:build
npm run site:worker:build
npm run check
npm test
(cd site && cargo check)
npx wrangler deploy --dry-run
```

Run the complete Worker-only application locally:

```sh
npm run site:build
npm run site:worker:build
npm run dev
```

Run stdio MCP:

```sh
nib auth login
nib auth status
nib --mcp
```

The device credential represents the verified user and is stored in the system Keychain. Headless automation should use a scoped, expiring expert token and revoke it from the account page or CLI when it is no longer needed.

Use `nib --llms-full`, the public `/openapi.json`, and the public `/.well-known/skills/index.json` for machine-readable discovery.

## Documentation

- [`docs/api.md`](docs/api.md): exact CLI, MCP, HTTP, background-job, and error contracts
- [`docs/architecture.md`](docs/architecture.md): component ownership and request/data flows
- [`docs/billing.md`](docs/billing.md): plans, limits, usage rates, Stripe lifecycle, and reconciliation
- [`docs/deployment.md`](docs/deployment.md): Cloudflare, AI Gateway, Access, Stripe, migrations, rollout, and rollback
- [`docs/security.md`](docs/security.md): trust boundaries, prompt/reference handling, retention, and abuse controls
- [`docs/operations.md`](docs/operations.md): observability, failures, queues, cleanup, and canaries
- [`docs/dogfood.md`](docs/dogfood.md): generate the first sales-page visual through Nib itself

## Upstream seam

The local Rust CLI pins Incurs 0.5.1, which carries the declarative MCP image presentation and complete generated-skill command examples this product needs; both landed upstream, so there is no local patch. Production remote MCP is still implemented directly in [`worker/src/mcp.ts`](worker/src/mcp.ts); Incurs is not hosted in production.

## External references

- [Cloudflare AI Gateway Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [Cloudflare AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Cloudflare Nano Banana 2 model schema](https://developers.cloudflare.com/ai/models/google/nano-banana-2/)
- [Cloudflare Nano Banana Pro model schema](https://developers.cloudflare.com/ai/models/google/nano-banana-pro/)
- [Cloudflare Workers Static Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Workers Rust language support](https://developers.cloudflare.com/workers/languages/rust/)
- [Cloudflare Workers service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Topcoat serverless router API](https://github.com/tokio-rs/topcoat/blob/f267417e28b4730aee9962aa935f1b1d3837b6b7/crates/topcoat-router/src/router.rs)
- [Topcoat Wasm support merge](https://github.com/tokio-rs/topcoat/pull/191)
- [Cloudflare stateless remote MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Cloudflare Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Stripe meter event API](https://docs.stripe.com/api/billing/meter-event/create)
