# Global Nib Code Mode

This Worker is adapted directly from the Incurs Cloudflare Code Mode example.
It keeps execution history, approvals, replay records, and artifacts in Durable
Object SQLite and runs generated JavaScript through Cloudflare Worker Loader.
The example `math` catalog is replaced with authenticated, global Nib request
operations.

Set `MCP_AUTH_TOKEN` for MCP clients. Set `NIB_AUTH_TOKEN` to a scoped Nib
service token, not the `nib-global` bootstrap secret. Wrangler 4.114.0 or newer
is required.

```sh
npx wrangler secret put MCP_AUTH_TOKEN
nib auth issue --name "Global Code Mode" --platform cloudflare-codemode --format json \
  | jq -r .token \
  | npx wrangler secret put NIB_AUTH_TOKEN
npx wrangler deploy
```

The issued token has `requests:read` and `requests:write` scopes. The command
prints the token once so that it can be piped directly into Wrangler. Do not
save the output.

`GET /health` verifies that the deployed Worker can authenticate to the global
Nib service with that scoped credential. It does not expose the credential or
request data. Calls from Code Mode to `nib-global` use the `NIB_PORTAL`
Cloudflare service binding rather than the public network.
