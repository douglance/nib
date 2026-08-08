# API contract

The Incurs catalog in [`src/catalog.rs`](../src/catalog.rs) is the only public operation catalog. Do not add a second MCP or HTTP-only operation without adding it there first.

## CLI

```text
nib generate [prompt]
  --ref <path>          Repeat zero to three times
  --quality <preset>    fast | standard | pro; default fast
  --aspect <ratio>      default 16:9
  --resolution <size>   1K | 2K | 4K; default 1K
  --image-format <format> png | jpg; default png
  --output <path>       Local output path
  --background          Queue instead of waiting
  --resume <job-id>     Inspect a queued/running/completed job
```

Valid aspect ratios are `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, and `21:9`. Fast supports only 1K. These constraints are enforced in both [`src/domain.rs`](../src/domain.rs) and [`worker/src/validation.ts`](../worker/src/validation.ts).

CLI references are file paths. MCP references are base64 data URIs. Supported MIME types are `image/png`, `image/jpeg`, and `image/webp`. Prompts are limited to 4,000 characters; each reference is limited to 10 MiB decoded and all references together to 20 MiB.

## MCP

- Transport: Streamable HTTP at `/mcp`, or stdio with `nib --mcp`.
- Tool name: `generate_ui`.
- Discovery: `initialize`, `notifications/initialized`, `ping`, and `tools/list` are public so an agent can install and inspect the tool before sign-in.
- Execution: `tools/call` requires a trusted tenant. The current implementation accepts a verified Cloudflare Access identity; scalable customer authentication remains a launch blocker.
- Result: text metadata, `structuredContent`, and an `image` content block on success.
- Semantics: one eligible Fast 1K trial image before payment; otherwise paid, non-read-only, non-destructive, non-idempotent, and open-world because it invokes an external model.

The rich image mapping is declared with JSON Pointers `/image/data` and `/image/mime_type` in [`src/catalog.rs`](../src/catalog.rs). Its generic Incurs support is vendored in [`patches/incurs-rich-mcp.patch`](../patches/incurs-rich-mcp.patch). The default Fast 1K request is eligible for the trial; Standard, Pro, and background work require a subscription.

## End-user authentication

Authenticate once under the end user's identity, then export the application token for the Nib CLI and local stdio MCP server:

```sh
cloudflared access login https://nib.doug-lance.workers.dev/internal/v1/generate
export NIB_ACCESS_TOKEN="$(cloudflared access token -app=https://nib.doug-lance.workers.dev/internal/v1/generate)"
```

The standalone CLI sends the token as `cf-access-token` to the Access-protected generation route. The public Streamable HTTP MCP route accepts unauthenticated discovery, then verifies the same token directly from `cf-access-jwt-assertion` on `tools/call`. Service tokens are only for private headless operators; they are not issued to trial users. See [Cloudflare's CLI Access flow](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/) and [coding-agent authentication guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/).

## Request

```json
{
  "prompt": "A calm account settings screen",
  "references": [],
  "quality": "fast",
  "aspect": "16:9",
  "resolution": "1K",
  "format": "png",
  "background": false
}
```

Only Worker-internal routing may supply `x-nib-tenant`. The Worker deletes any caller-provided tenant header and replaces it with the verified identity before invoking generation; see [`worker/src/access.ts`](../worker/src/access.ts) and [`worker/src/index.ts`](../worker/src/index.ts).

Standalone CLI and stdio MCP calls post to `/internal/v1/generate`. Remote MCP calls enter the Worker-native stateless Streamable HTTP handler at `/mcp`. Both paths invoke [`handleGeneration`](../worker/src/generation.ts) inside the same Worker after authentication; there is no process or Container hop.

## Response

```json
{
  "job_id": "uuid",
  "status": "succeeded",
  "model": "google/nano-banana-2",
  "quality": "standard",
  "aspect": "16:9",
  "resolution": "2K",
  "format": "png",
  "usage_cents": 32,
  "artifact_url": "https://nib.example.com/artifacts/uuid",
  "image": {
    "data": "base64...",
    "mime_type": "image/png"
  },
  "output_path": null
}
```

The CLI decodes `image.data`, writes the requested output path, removes the inline image from printed structured output, and returns `output_path`. Agent transports retain the inline image so MCP can present it.

## Background jobs

Set `background: true` or pass `--background`. The response status is `queued`. Later call the same operation with `resume_job_id` or `--resume`; the original prompt is not required for a resume call.

The Durable Object scheduler chooses four High jobs, then one Default job, with fallback when one queue is empty. A Workflow runs the chosen job with three exponential-backoff retries. Source: [`worker/src/scheduler.ts`](../worker/src/scheduler.ts) and [`worker/src/generation.ts`](../worker/src/generation.ts).

## Errors

| Status/code | Meaning |
| --- | --- |
| `400` | Invalid prompt, reference count, aspect, preset, or resolution |
| `401` | No trusted Cloudflare Access tenant |
| `402 FREE_TRIAL_FAST_1K_ONLY` | An unsubscribed identity requested Standard, Pro, or output above 1K |
| `402 FREE_TRIAL_BLOCKING_ONLY` | An unsubscribed identity requested background generation |
| `402 FREE_TRIAL_USED` | The verified identity consumed its one free image |
| `403 FREE_TRIAL_NETWORK_REQUIRED` | Cloudflare did not supply a network context for the trial request |
| `404` | Job or retained artifact does not exist for this tenant |
| `429 FREE_TRIAL_NETWORK_LIMIT` | Three trial identities used the network cohort during the last 30 days |
| `429 FREE_TRIAL_DAILY_LIMIT` | The global allowance of 50 new trial identities was reached for the UTC day |
| `429 RATE_LIMITED` | Per-tenant minute allowance exhausted |
| `429 CONCURRENCY_LIMIT` | Blocking concurrency exhausted |
| `429 QUEUE_FULL` | Background queue allowance exhausted |

## Discovery

| Resource | Path |
| --- | --- |
| OpenAPI | `/openapi.json` |
| Skill index | `/.well-known/skills/index.json` |
| Generate skill | `/.well-known/skills/generate/SKILL.md` |
| Remote MCP skill | `/install/nib-ui-image/SKILL.md` |
| Agent installer | `/install-agent.md` |
| MCP | `/mcp` |
| Health | `/health` |

OpenAPI, both skill resources, the agent installer, and the non-executing MCP discovery methods are public so agents can install and inspect the tool before authentication. MCP `tools/call`, generation, artifacts, account, and billing operations remain behind Cloudflare Access.
