# Global Nib Code Mode

This Worker is adapted directly from the Incurs Cloudflare Code Mode example.
It keeps execution history, approvals, replay records, and artifacts in Durable
Object SQLite and runs generated JavaScript through Cloudflare Worker Loader.
The example `math` catalog is replaced with authenticated, global Nib request
operations.

Code Mode uses the same Nib account session as every other client. Sign in with
`nib auth login`, then send that session as the MCP bearer token. Wrangler
4.114.0 or newer is required.

```sh
npx wrangler deploy
```

`GET /health` verifies the private review-service binding. Each MCP request is
validated against the Nib account service, then routed to that account's
Durable Object. Calls use Cloudflare service bindings rather than public
service URLs.
