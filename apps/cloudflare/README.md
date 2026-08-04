# Nib global service

This Worker is the always-available rendezvous for Nib requests. Durable Object
storage owns request state and R2 owns image, `.nib`, and MP4 attachments. The
CLI and installed native clients connect outbound to this service; no machine
on the private network is an origin or availability dependency.

## Deploy

```sh
npm install
npx wrangler r2 bucket create nib-global-media
npx wrangler secret put NIB_AUTH_TOKEN
npm run deploy
```

`NIB_AUTH_TOKEN` is the Worker bootstrap secret. Do not copy it into an app,
Code Mode Worker, configuration file, or shell profile.

Enroll the CLI once, then remove the bootstrap value from the environment:

```sh
export NIB_AUTH_TOKEN
nib auth login
unset NIB_AUTH_TOKEN
nib auth status
```

`nib auth login` exchanges the bootstrap value for a scoped token and stores
that token in macOS Keychain. Existing CLI and macOS app credentials stored in
UserDefaults migrate through the same exchange.

Enroll an iPhone, Apple Watch, Apple Vision Pro, or another Mac with a one-time
pairing code:

```sh
nib auth pair
```

Open the returned `nib://` URL on the device or paste the code in Nib settings.
The code expires after 10 minutes and works once. `NIB_PORTAL_URL` can override
the Worker URL for a development or recovery deployment.
