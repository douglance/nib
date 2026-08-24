# Nib global service

This Worker is the always-available rendezvous for Nib requests. Durable Object
storage owns request state and R2 owns image, `.nib`, and MP4 attachments. The
CLI and installed native clients connect outbound to this service; no machine
on the private network is an origin or availability dependency.

## Deploy

```sh
npm install
npx wrangler r2 bucket create nib-global-media
npx wrangler secret put NIB_APNS_TEAM_ID
npx wrangler secret put NIB_APNS_KEY_ID
npx wrangler secret put NIB_APNS_PRIVATE_KEY
npm run deploy
```

`NIB_APNS_PRIVATE_KEY` is the complete PKCS#8 `.p8` file contents, including
its header and footer. Every Apple app registration supplies its exact bundle
topic and either the APNs sandbox or production environment. Incomplete device
registrations are rejected; the Worker has no global topic or environment
fallback.

Each published request is sent to every registered iOS, visionOS, watchOS, and
macOS device. The first response is committed atomically. An
`Idempotency-Key` retry returns that response, while a different later response
receives `409`. The Worker then sends a collapsed background resolution push to
every device so delivered notifications and active inboxes converge.
Alert payloads are compacted to APNs' 4 KB limit without removing the request
identity. Transient APNs failures are retried up to three times, and tokens that
APNs reports as unregistered or invalid are removed from the device registry.

Sign in to the CLI with the same Nib account used by the Apple apps:

```sh
nib auth login you@example.com
nib auth status
```

Open the emailed link to finish. The CLI stores the resulting account session
in macOS Keychain. iPhone, Apple Watch, Apple Vision Pro, and Mac use this same
email flow. The only service origin is `https://nibtool.com`.
