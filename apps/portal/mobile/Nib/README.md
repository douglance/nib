# Nib native client

This directory contains the iPhone, Watch, Vision Pro, and Mac clients for the
unified nib system.

The app is not a separate product surface with separate APIs. It consumes the
same resources as web, CLI, and MCP:

- `GET /api/projects`
- `GET/POST /api/requests`
- `POST /api/requests/:id/respond`
- `POST /api/requests/:id/attachments`
- `GET/POST /api/devices`
- `GET /api/activity`

Nib Cloud is the authority for accounts, requests, immutable `.nib` history,
attachments, device registrations, and APNs delivery. Native clients use the
same account and cloud history on every supported platform. Opening an existing
`.nib` is read-only; starting an edit creates a new cloud record.

## v1 screens

- Inbox: pending requests, quiet status, device health.
- Request detail: prompt, choices, text reply, screenshots, attachments.
- Expanded notifications: full request text, inline note field, and decision actions.
- Website view: in-app `WKWebView` for nib viewer URLs, Safari fallback.
- Capture: camera or photo-library upload to a request.
- Watch inbox: pending requests, approve/deny, numbered choice, dictation text.
- Watch projects: project status, recheck, route switching, and confirmation-gated kill.
- Vision Pro: the full native inbox, request detail, attachments, text and choice
  responses, visual-review decisions, live request updates, and APNs delivery.

## Visual direction

The app should feel like a crafted object: restrained, precise, tactile, and
calm. Use warm neutral surfaces, native typography, soft depth, minimal icons,
and generous space. Avoid loud SaaS styling, gamified colors, novelty motion,
and generic dashboard density.

See `DESIGN.md` for the implementation rules.

## Setup notes

Bundle identifiers default to:

- `com.douglance.nib`
- `com.douglance.nib.NotificationService`
- `com.douglance.nib.NotificationContent`
- `com.douglance.nib.watchkitapp`
- `com.douglance.nib.macos`

The iPhone and Vision Pro builds share `com.douglance.nib` as one universal
app identity. The Mac app uses its own identifier because its capture and
sandbox capabilities are Mac-specific.

Store copy, URLs, review instructions, and localized text live in `AppStore/`.
Use `ExportOptions-AppStore.plist` for iPhone and Vision Pro App Store packages.
Use `ExportOptions-DeveloperID.plist` for a Mac build distributed outside the
Mac App Store. A direct Mac release must have a push-enabled Developer ID
provisioning profile, hardened runtime, a Developer ID signature, and an Apple
notarization ticket before publication.

Production APNs credentials are configured as Cloudflare Worker secrets:

- `NIB_APNS_TEAM_ID`
- `NIB_APNS_KEY_ID`
- `NIB_APNS_PRIVATE_KEY`

Each device registration carries its exact environment and topic. The Worker
rejects incomplete registrations. See `../../../cloudflare/README.md` for the
deployment commands and health check.

The key must be an Apple Developer APNs provider authentication key. App Store
Connect API keys are also `.p8` files, but APNs rejects them with
`InvalidProviderToken`.
