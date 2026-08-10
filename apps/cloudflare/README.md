# Nib global service

This Worker is the always-available rendezvous for Nib requests. Durable Object
storage owns request state and R2 owns image, `.nib`, and MP4 attachments. The
CLI and installed native clients connect outbound to this service; no machine
on the private network is an origin or availability dependency.

The stable `/v1` API implements the open Nib Request protocol. It supports
idempotent request creation and revision, capability-scoped guest review,
structured feedback and decisions, replayable JSON or SSE events, signed
webhook continuations, and single-part or native R2 multipart artifact uploads.
See [`docs/request-api.md`](../../docs/request-api.md) for the route contract.

Hosted multipart uploads use Cloudflare R2 native multipart state in production:
the Durable Object stores the `uploadId` and returned part `etag`s, then calls
R2 `complete` or `abort`. The Worker validates declared part sizes and any
declared per-part SHA-256 values before upload. For large multipart objects the
declared full SHA-256 is retained as object metadata; production completion does
not read back and assemble all parts in Worker memory to recompute the full hash.

## Deploy

```sh
npm install
npx wrangler r2 bucket create nib-global-media
npx wrangler secret put NIB_AUTH_TOKEN
npm run deploy
```

`NIB_AUTH_TOKEN` is the Worker bootstrap secret. Do not copy it into an app,
Code Mode Worker, configuration file, or shell profile. Nib Cloud reaches this
Worker through a private service binding instead.

People enroll the CLI through the hosted account portal:

```sh
nib auth login
nib auth status
```

`nib auth login` opens `app.nibtool.com`, waits for an email or passkey sign-in,
and stores the approved device credential in the system Keychain.
`NIB_PORTAL_URL` can override the portal URL for development or recovery.

## Managed tenancy boundary

The public HTTP entrypoint always uses the public/default tenant and ignores
tenant-selection headers. Nib Cloud receives a named service binding to the
Worker and selects an organization tenant through the typed RPC entrypoint.
Possession of the private service binding is the authorization boundary; no
tenant-routing secret or customer-controlled header crosses public HTTP.
