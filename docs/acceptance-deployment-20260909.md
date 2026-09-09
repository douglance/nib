# Acceptance staged deployment, September 9, 2026

Source commit `45074268c363876e74b698d019a3d08b50f65729` is pushed to `douglance/nib`, branch `feat/acceptance-v1`. The acceptance implementation is deployed to the production Workers with `ACCEPTANCE_ENABLED=false`. This is a staged deployment, not completion of the day-30 pilot.

| Surface | Deployed version | Previous rollback version |
| --- | --- | --- |
| Public Worker `nib` | `6f28058d-41d5-415f-9390-db1d11df109d` | `1c8c7058-8a14-45e9-b062-6d687caa16fa` |
| Review Worker `nib-global` | `1c793556-5e60-40e4-871d-bd451bc2e147` | `ac3b6fa2-b440-41ac-aa8e-864b7f17962a` |

The deployment message on each Worker records the source SHA. Public deployment execution: `01a08550-a80a-7202-83b1-5c044f215884`. Review deployment: `01a08550-9606-7591-a0ba-ce4bf4d44021`. Git push: `01a08550-8990-74b3-b271-7f255382bb95`.

Production D1 migrations `0015` through `0019` applied successfully (`01a0854f-c8bf-77e0-8f75-a5d8e6bc8fc3`). Queues `nib-acceptance-events` and `nib-acceptance-events-dlq` were created and the public Worker now has its acceptance Queue consumer and Durable Object binding. An Ed25519 signing key was generated directly into Worker secrets without printing or committing its private value; its public key ID is `nib-acceptance-20260909`.

Live smoke execution `01a08551-625f-7a60-886f-57ad9acba530` verified:

| Request | Observed result |
| --- | --- |
| `GET /health` | `200` |
| `GET /.well-known/acceptance-jwks.json` | `200`, expected Ed25519 public key ID |
| `GET /acceptance` | `503`, feature disabled |
| Unauthenticated `GET /api/requests` | `401` |
| `GET /auth/sign-in` | `200` |
| `POST /api/acceptance/v1/projects/:id/reviews/:id/verify` | `503`, `satisfied:false`, `acceptance_disabled` |

The existing `APNS_ENVIRONMENT`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, and `APNS_TEAM_ID` secret bindings remain on `nib-global` (`01a08551-62e2-7820-9c7a-4d79df9caa13`). Binding presence does not prove notification delivery; no live email or APNs message was sent during this rollout.

## Profile resolution

The earlier authentication failures came from running outside the configured apoc profile. Both Nib checkout paths now map to `lv`. GitHub's authenticated `/user` API confirms `douglance` (`01a0854c-dddf-72f1-83fb-41e9add2b66d`), and Cloudflare operations succeeded through that profile's Wrangler configuration. Code Mode must select the profile at the outer execution boundary. When invoking repository-local Wrangler, pass the profile's `LV_WRANGLER_XDG_CONFIG_HOME` as the child's `XDG_CONFIG_HOME`; the profile's `wrangler` wrapper already does this.

## Rollback and remaining launch work

To roll back, use the appropriate Worker's configuration and `wrangler rollback VERSION_ID` through the same apoc profile. Restore the public Worker first, then the review Worker using the previous versions above. Leave the additive D1 migrations and Queue resources in place. The acceptance feature must remain disabled until GitHub App registration and the live flow are ready.

Remaining evidence: GitHub App registration and installation, its three Worker secret bindings, real isolated preview publication, multi-account email/device delivery, GitHub checks and customer webhook consumption, three hosted examples, and a new team completing the review without builder assistance. Apoc's browser extension bridge was disconnected when registration was checked (`exec_0001788943134442_00000000000009c5`); no browser registration was completed.
