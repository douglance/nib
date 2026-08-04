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

The Mac nib server remains the authority for project discovery, tmux,
command execution, local website proxying, screenshots, storage, and APNs
delivery. The native app is the high-trust mobile control surface.

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

Use TestFlight distribution for v1. Bundle identifiers default to:

- `com.douglance.nib`
- `com.douglance.nib.NotificationService`
- `com.douglance.nib.NotificationContent`
- `com.douglance.nib.watchkitapp`

The iPhone and Vision Pro builds share `com.douglance.nib` as one universal
app identity.

APNs credentials are configured on the Mac server with:

- `NIB_APNS_TEAM_ID`
- `NIB_APNS_KEY_ID`
- `NIB_APNS_KEY_PATH`
- `NIB_APNS_TOPIC`
- `NIB_APNS_ENV=sandbox|production`

Use `npm run apns:configure -- TEAM KEYID /absolute/path/AuthKey_KEYID.p8 com.douglance.nib sandbox`
to write these values into `.nib/server.env`. That file is ignored by git and
is loaded by `scripts/start-production.sh`, so APNs config survives
`npm run launchd:install`.

The key must be an Apple Developer APNs provider authentication key. App Store
Connect API keys are also `.p8` files, but APNs rejects them with
`InvalidProviderToken`.
