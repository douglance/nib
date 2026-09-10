# Acceptance pilot safeguards deployment, September 10, 2026

The public Worker runs source `dae0026652c8675385618cd5e6df5da0d6759f6b` with `ACCEPTANCE_ENABLED=false`. Pilot account/project restrictions, GitHub PR provenance checks, and queued-delivery restrictions are deployed. The internal trial has not started.

This record is for the operator continuing the restricted pilot. It updates the public Worker portion of the [September 9 deployment](acceptance-deployment-20260909.md).

| Surface | Deployed version | Rollback version |
| --- | --- | --- |
| Public Worker `nib` | `a5481cb1-a571-4468-a74d-22dd887c14cc` | `6f28058d-41d5-415f-9390-db1d11df109d` |
| Review Worker `nib-global` | Retained `1c793556-5e60-40e4-871d-bd451bc2e147` | See September 9 record |

Public deployment execution `01a08931-b34a-72b2-a889-da98d4b20e1e` succeeded after the previous deployed version was checked. Production migration `0020` applied in `01a0892f-90ae-71d1-9293-9038719a47bf`. The migration adds GitHub PR provenance and build-commit fields; leave this additive migration in place when rolling back. The deployment preserved existing secret bindings and did not deploy the review or site Workers. Source push succeeded in `01a0892c-fb7f-71f0-a6c7-84058d4eae15`.

Live smoke execution `01a08933-a840-7ec1-b25a-bd144931c818` observed:

| Request | Result |
| --- | --- |
| `GET /health` | `200` |
| `GET /.well-known/acceptance-jwks.json` | `200`, key ID `nib-acceptance-20260909` |
| `GET /acceptance` | `503`, `acceptance_disabled` |
| `POST /api/acceptance/v1/github/token` | `503`, `acceptance_disabled` |
| `POST /api/acceptance/v1/projects/:id/reviews/:id/verify` | `503`, `satisfied:false`, `acceptance_disabled` |

## Activation prerequisites

GitHub and Cloudflare CLI access work through apoc profile `lv`. The remaining prerequisites are specific to the pilot:

1. Complete GitHub App registration and install it on the selected repository. The loopback manifest registration helper is implemented and tested; no completed registration or installation was observed in this run.
2. Authenticate the pilot owner, create the team/project, and configure both account and project allowlists using [Acceptance Operations](acceptance-operations.md). The email login challenge from this run expired before authentication completed.
3. Configure the protected CI environment, a dedicated Cloudflare API token, and preview-only secrets, including Stripe test credentials and prices. Local preflight found no preview Stripe key or Cloudflare API token. Wrangler's local OAuth access does not supply CI credentials.
4. Unlock the Mac login keychain and complete a signed build, installation, and real notification check. The native build reached signing, then failed with `errSecInternalComponent` in `01a0890a-d340-7ab1-81cc-a1af3d7a6ba5`; keychain inspection returned `User interaction is not allowed`.
5. Enable acceptance with the restricted allowlists and run the Web and Mac pilot, then collect the hosted examples and independent-team evidence in the [day-30 audit](acceptance-30d-audit.md).

The registration UI was initially accessible, then native browser accessibility stopped exposing the window. That observation does not establish whether the screen was locked. No App, hosted preview, notification delivery, accepted GitHub check, or independent-team result is claimed.

For immediate rollback, keep acceptance disabled and roll public Worker `nib` back to `6f28058d-41d5-415f-9390-db1d11df109d` through the same profile. Do not roll back the review Worker for this public-Worker-only release.
