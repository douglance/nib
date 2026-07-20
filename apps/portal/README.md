# Nib portal

This package is Nib's private web, server, push, iPhone, and Watch surface. It
is part of the main Nib repository and is not a second product or CLI.

The canonical `nib` command and native desktop annotation engine remain in the
Rust workspace at the repository root. The portal provides remote review over
the tailnet and uses the same request and annotation contracts.

## Local development

```bash
npm ci
npm run dev
```

The server and Vite client bind to loopback by default. Production is exposed
only through Tailscale Serve at `https://dave.tail5d92b4.ts.net`.

## Validation

```bash
npm run verify
xcodegen generate --spec mobile/Nib/project.yml
xcodebuild -project mobile/Nib/Nib.xcodeproj -scheme Nib \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

## Runtime data

Runtime state lives under `.nib/` and is never committed. The old service's
data is migrated once during deployment; new installs use only Nib names,
environment variables, bundle identifiers, notification categories, and URL
schemes.
