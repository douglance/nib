# Dogfood the sales visual

The first sales-page visual in `site/src/generated-ui-hero.png` came from Nib through Cloudflare's `google/nano-banana-2` model. The asset build copies that image into the public Worker's static asset payload. The page around it is rendered on each request by the Topcoat Rust/Wasm Worker.

The dogfood environment runs the same Workers-only topology as production. Wrangler runs the Worker, Workers Static Assets, D1, R2, Durable Objects, the Queue consumer, and the generation Workflow locally. Only the Workers AI binding is remote, so Gemini inference is charged to the selected Cloudflare account through Unified Billing.

```text
nib CLI or MCP client
            |
            v
local public Cloudflare Worker
  |-- SITE binding -> Topcoat Rust/Wasm Worker
  |-- stateless MCP or generation route
  |-- TenantGate / TrialGate / Scheduler
  |-- GenerationWorkflow -> remote Workers AI -> Gemini
  |-- D1 job and usage ledger
  |-- R2 artifact
  `-- metering Queue
```

## Prepare

Build the Topcoat Worker and asset snapshot, apply the local schema, and create an isolated paid dogfood tenant:

```sh
npm run site:build
npm run site:worker:build
npx wrangler d1 migrations apply nib --local --config wrangler.dogfood.jsonc
npx wrangler d1 execute nib --local --config wrangler.dogfood.jsonc \
  --command "INSERT OR IGNORE INTO accounts(tenant_id, plan, created_at, updated_at) VALUES ('dogfood@nib.local', 'default', unixepoch(), unixepoch())"
```

Run the Worker:

```sh
npx wrangler dev --config wrangler.dogfood.jsonc --port 8790
```

`wrangler.dogfood.jsonc` sets `ENVIRONMENT=development`, so the local-only `x-nib-dev-tenant` header can select the isolated tenant. Production ignores that header.

## Generate

```sh
NIB_BACKEND_URL=http://127.0.0.1:8790/internal/v1/generate \
NIB_DEV_TENANT=dogfood@nib.local \
nib generate \
  "A raw 4:3 dark analytics application viewport for a precise developer tool. Dense but calm hierarchy, compact left navigation, two metrics, a restrained line chart, near-black surfaces, lime action accent, blue data accent. Interface only. No browser chrome, device frame, annotations, marketing copy, or surrounding scene." \
  --quality standard \
  --resolution 1K \
  --aspect 4:3 \
  --image-format png \
  --output site/src/generated-ui-hero.png
```

After accepting the image, run `npm run site:build` again so `site/dist/assets/generated-ui-hero.png` matches the source asset.

## Verify MCP

Without a job ID, the verifier initializes the Worker-native Streamable HTTP MCP server and asserts that `tools/list` exposes exactly `generate_ui`:

```sh
npm run dogfood:mcp
```

With a completed job ID, it also resumes that job and requires structured job metadata plus an MCP image content block:

```sh
npm run dogfood:mcp -- <JOB_ID>
```

Resuming does not create another image or usage row. It reads the funded job and private R2 artifact through the same Worker boundary.

## Accept

Accept the visual only when:

- it is exactly one interface viewport;
- no device, browser chrome, annotation, review, or marketing scene appears;
- the principal hierarchy survives the 4:3 crop;
- text and contrast remain intentional at the rendered size;
- the generation job is `succeeded` and has one usage-ledger row;
- Stripe receives a meter event only when the tenant has a Stripe customer.

Verify the routed surfaces:

| Request | Expected result |
| --- | --- |
| `GET /health` | `200` |
| `GET /` | `200` |
| `GET /` response header | `x-nib-renderer: topcoat-wasm-worker` |
| `GET /assets/generated-ui-hero.png` | `200` |
| MCP `initialize` and `tools/list` | Success; exactly `generate_ui` |
| `GET /account` without authentication | `401` |
| `POST /internal/v1/generate` without authentication | `401` |

Inspect the Worker-served home page at 1440 px and 390 px widths. Release acceptance is no horizontal overflow, no browser console errors, a pinned footer on short content, and passing accessibility, best-practices, SEO, and agentic-browser checks.

Keep the job ID and artifact URL in release evidence, not public page source. A `502` response with `GENERATION_FAILED` and an `AiGatewayError` means the request reached Cloudflare but third-party inference was unavailable; verify the Unified Billing credit balance and model availability before retrying.

## Cloudflare references

- [Workers Static Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Stateless remote MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Local and remote binding behavior](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)
- [Queues local development](https://developers.cloudflare.com/queues/configuration/local-development/)
