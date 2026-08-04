# Nib portal

This package is Nib's private web, server, push, iPhone, and Watch surface. It
is part of the main Nib repository and is not a second product or CLI.

The canonical `nib` command and native desktop annotation engine remain in the
Rust workspace at the repository root. The production request relay is the
Cloudflare Worker in `../cloudflare`; this package remains the complete local
development portal and uses the same request and annotation contracts.

## Local development

```bash
npm ci
npm run dev
```

The server and Vite client bind to loopback by default. They are not required
for the global Cloudflare request path.

## Validation

```bash
npm run verify
xcodegen generate --spec mobile/Nib/project.yml
xcodebuild -project mobile/Nib/Nib.xcodeproj -scheme Nib \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project mobile/Nib/Nib.xcodeproj -scheme NibMac \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
```

The request API accepts `nib.review/v2` video subjects, streams raw H.264 MP4
uploads, serves byte ranges for seeking, and accepts an optional MP4 response
attachment. Reviewers pause the video before annotating; each annotation stores
its media timestamp.

## Runtime data

Runtime state lives under `.nib/` and is never committed. The old service's
data is migrated once during deployment; new installs use only Nib names,
environment variables, bundle identifiers, notification categories, and URL
schemes.
