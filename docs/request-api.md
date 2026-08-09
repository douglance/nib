# Hosted Nib Request API v1

The hosted API exposes the open Nib Request protocol over HTTP. The default
production origin is `https://nibtool.com`. Self-hosted deployments expose the
same `/v1` routes.

## Lifecycle

```text
POST request -> upload artifacts -> reviewer decides -> event emitted
      |                                      |
      +----------- webhook or poll ----------+
```

Request creation, mutation, decisions, feedback, capability management, and
artifact state changes require an `Idempotency-Key` header. A retry with the
same key returns the original result instead of repeating the operation.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/v1/requests` | Create revision 1 and return its optional `reviewLink` |
| `GET` | `/v1/requests/:id` | Read the canonical request and current status |
| `POST` | `/v1/requests/:id/revisions` | Create an immutable next revision |
| `POST` | `/v1/requests/:id/revisions/:revision/publish` | Make a draft revision reviewable |
| `GET/POST` | `/v1/requests/:id/decisions` | List or submit structured decisions |
| `GET/POST` | `/v1/requests/:id/feedback` | List or submit comments and annotations |
| `GET` | `/v1/requests/:id/events` | Replay this request's events as JSON or SSE |
| `GET` | `/v1/events` | Replay all authorized events as JSON or SSE |
| `POST` | `/v1/requests/:id/capabilities` | Create a scoped, expiring guest capability |
| `POST` | `/v1/requests/:id/capabilities/:capabilityId/revoke` | Revoke a capability |
| `GET/POST` | `/v1/requests/:id/artifacts` | List hosted artifacts or initiate an upload |
| `PUT` | `/v1/requests/:id/artifacts/:artifactId/complete` | Upload and complete a small object |
| `PUT` | `/v1/requests/:id/artifacts/:artifactId/parts/:part` | Upload one native multipart object part |
| `POST` | `/v1/requests/:id/artifacts/:artifactId/finalize` | Complete a multipart object |
| `POST` | `/v1/requests/:id/artifacts/:artifactId/abort` | Abort an incomplete upload |
| `GET` | `/v1/requests/:id/artifacts/:artifactId/content` | Read authorized bytes, including HTTP Range |

Unknown same-major protocol fields are preserved where the model permits them.
Unsupported protocol major versions are rejected.

## Assets

R2 stores image, video, HTML, JSON, `.nib`, and other binary evidence. The
request Durable Object stores metadata, upload state, SHA-256 integrity, and
the content-addressed object reference. Already compressed media is stored as
bytes and is not recompressed by Nib.

The initiation response chooses a single or multipart upload. Clients must use
the returned URLs rather than infer an upload strategy. Multipart completion
uses R2's native upload ID and part ETags, so large video is never assembled in
Worker memory. Authorized content responses support `Range` for browser video
seeking.

## Guest review

A review link places its capability in the URL fragment so browsers do not send
it in HTTP requests, access logs, or referrers. The reviewer exchanges that
capability for an opaque, request-scoped, expiring review session. The session
authorizes only the granted operations and can be revoked. It is not an account
session and never selects an organization tenant.

The browser reviewer renders the canonical request, hosted and external
artifacts, comments, and the three stable outcomes: `approved`, `rejected`, and
`changes_requested`. External URLs are restricted to safe web origins.

## Continuation and events

Requests may include a write-only HTTPS webhook continuation. The public request
and event stream expose only that a webhook is configured; they never return its
URL or secret. Deliveries are signed and carry a stable delivery key so receivers
can reject tampering and safely deduplicate retries.

For polling, use `after=<cursor>`. For SSE, send
`Accept: text/event-stream` and resume with `Last-Event-ID`. CI and agents can
exit after request creation and later resume from either transport.

## Deployment boundary

Public HTTP cannot select a hosted tenant. The managed Nib Cloud Worker calls a
named `WorkerEntrypoint` over a Cloudflare service binding and passes the tenant
identifier through typed RPC. This prevents an Internet client from spoofing a
tenant header while keeping the open-source Worker independently deployable.
