# Nib Apple apps

The retired local portal has been removed. `mobile/Nib` contains the iPhone,
Apple Watch, Apple Vision Pro, and Mac clients. Every client uses the fixed
`https://nibtool.com` production origin and the same Nib account.

Product, account, billing, and public-site code lives in `apps/web`. Durable
requests, immutable `.nib` history, media, device registrations, and APNs live
in `apps/cloudflare` behind the same public origin.

Generate and validate the Apple project directly:

```bash
xcodegen generate --spec mobile/Nib/project.yml --project mobile/Nib
xcodebuild -project mobile/Nib/Nib.xcodeproj -scheme Nib \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project mobile/Nib/Nib.xcodeproj -scheme NibMac \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO test
```
