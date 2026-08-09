# Open-core boundary

Nib uses an Apache 2.0 open-core model. The public repository contains the local screenshot, annotation, review, rendering, and UI-generation client code, plus the public website and versioned hosted-service interfaces.

The hosted service is a separate proprietary product. Its implementation is not part of the Apache-licensed work.

| Public Apache 2.0 | Private hosted service |
| --- | --- |
| Rust CLI and desktop/local workflows | Generation orchestration and model-provider calls |
| Capture, annotation, review, rendering, and local storage | Customer identity, tenant enforcement, trials, and abuse controls |
| `nib-ui` HTTP/MCP client and domain types | Billing, rate cards, metering, and subscription lifecycle |
| Public site, install docs, OpenAPI, MCP, and skill fixtures | D1 migrations, R2 retention, queues, workflows, and deployment configuration |
| npm launcher and release binaries | Operations, security, and commercial runbooks |

The stable seam is `generate_ui`: public clients may call the hosted API, but the server-side implementation and commercial controls remain private. Changes to the hosted service must continue to satisfy the fixtures under `contracts/cloud/v1/`.

Run `node scripts/check-open-core-boundary.mjs` before publishing a public branch. It rejects known private paths, credential names, accidental Cargo publication, and license drift.
