# Acceptance v1 validation

Implementation validation for `feat/acceptance-v1`, September 9, 2026. The implementation is isolated in the `nib-acceptance-v1` worktree; the original `nib` checkout remains on `merge/visualize`.

## Executable evidence

| Area | Result | Durable execution |
| --- | --- | --- |
| Web Worker suite, including real workerd integration | 31 files, 215 tests passed | `01a0853a-a3c1-70d1-8c75-8bab525b7c89` |
| Existing review service and acceptance notification routing | 7 files, 38 tests passed | `01a0843a-867a-7200-bdee-5a43c0bbd89f` |
| GitHub Action, including ownership-proof link mode | 7 tests passed | `01a0853a-a448-73b3-a2ab-d73458a77b3b` |
| Cloudflare adapter, including migration-before-seed, private routing, CLI failure exit, provider attestation, and teardown retry | 22 tests passed | `01a0853a-a448-73b3-a2ab-d73458a77b3b` |
| Web TypeScript | Passed | `01a0853a-a3c1-70d1-8c75-8bbd48967624` |
| Real Chrome desktop/mobile acceptance flow | Passed; screenshots inspected | `01a0843e-f63b-7470-829e-2cee5035071a` |
| Rust CLI compatibility entrypoint against workerd | Export passed; offline historical receipt passed; superseded live gate failed with exit 1 | `01a08443-11b9-7c42-812d-65f84b84c47d` |
| Default Rust CLI entrypoint against workerd | Export and historical receipt verification passed; superseded live gate failed with exit 1 | `01a08446-d4b0-7192-8d3a-ef5013649979` |
| Rust check with all features | Passed | `01a08424-9109-7f01-b73f-38bcc64a3881` |
| Rust tests with all features | Passed | `01a08427-23ac-7651-b760-d787f32983d2` |
| Rust Clippy with all features and warnings denied | Passed | `01a08427-a466-72e0-9a63-9ea2f7c8649e` |
| Rust formatting | Passed | `01a08427-f25e-78b1-a493-d0ee1c2811b7` |
| Site asset build | Passed with an explicit local C linker path | `01a0842f-0fad-7e83-83b3-3c7feb4bc4ef` |
| Public Worker deployment bundle | Wrangler dry run passed after repository-revocation fixes | `01a08465-3041-7942-931f-d77a443618dd` |
| Review-service deployment bundle | Wrangler dry run passed | `01a08430-da6a-7363-88ba-6fcc5ce4b3cf` |
| iOS and watchOS builds, macOS tests | Passed without code signing | `01a08404-f770-77c2-8c15-e45b1ffaf7be` |

Three full-stack application examples passed in `01a0853c-1845-7261-8991-2e645d2dbbd5`: authenticated request routing to the real review service, production trial network limits against local storage, a real local metering-queue send matched to the ledger, and permissions including viewer invalidation denial. These runs use mocked Stripe/AI, local email, unconfigured APNs, and a test site shell. They do not establish hosted preview or notification delivery. [Reproduction and deployment inputs](acceptance-examples.md) distinguish the local runner from the three Cloudflare recipes.

All three recipes prepared and planned with concrete identifiers, private dependency Workers, and preserved production business-rule configuration in `01a0853c-1842-7c91-b1ef-446a8ba241a6`. Seed schema/replay validation passed in `01a0846b-eea4-7f52-b190-8edebf870d4f`. Actual Wrangler local migrations and both seeds passed in `01a0846d-0393-7552-b829-7d40fd3cbac3`, `01a0846d-3321-7210-a5c2-10027aa90f13`, and `01a0846d-5697-7f13-9c70-88d548aaa444`; queries confirmed five accounts, one team, four team members, one project, and three project roles.

The workerd scenario executes the HTTP API with D1, R2, and SQLite Durable Objects. It covers teams, project access, invitations, evidence upload and retrieval, concurrent approvals for quorum two, signed receipts, membership revocation, same-subject revision supersession, a comment/publication race, and persistence after Durable Object eviction. Its build provider is `external`; Cloudflare control-plane behavior is tested separately with mocked API and command responses.

Security review rechecked the reported ownership, teardown, provider freshness, workflow commit, and delivery-recovery defects after repair. No unresolved finding remained in that inspected scope. Provider reports remain assertions from authorized customer automation, with a 60-second validity window; they are not Cloudflare-signed proofs.

The browser run used the real local API for team/project creation, wrong-email and valid invitation acceptance, viewer restrictions, comments, preview-open recording, two distinct reviewer approvals, and a superseding revision. Desktop and mobile captures were inspected after fixing dark navigation contrast, reviewer identity, duplicate-vote controls, and preview access on completed reviews. Keyboard order was sampled, and the inspected pages had no visible clipping or blocking unlabeled controls. The external preview URL was a test fixture; a click does not prove the preview's behavior.

Repository installation linking separately requires a valid signed ownership proof from the target repository's default branch. JOSE-signed regression cases reject missing and forged proofs, another repository, another branch, and PR events before storing the installation. The Action's `link` mode obtains this proof inside GitHub; no real GitHub link workflow was executed locally. The final masked ownership-proof form field has focused template/type checks, following the broader browser run above. The disabled-state tests keep signed GitHub webhooks reachable while global acceptance is paused and return `503` for workflow-token and gate routes.

## Reproduce locally

Use Node 24 for the Worker tests, including the Node SQLite test fixtures.

```sh
npm ci --prefix apps/web
npm ci --prefix apps/cloudflare
npm run check --prefix apps/web
npm test --prefix apps/web
npm test --prefix apps/cloudflare
node --test integrations/github-action/index.test.mjs integrations/cloudflare/test/cloudflare-preview.test.mjs
cargo check --all-features
cargo test --all-features
cargo clippy --all-features -- -D warnings
cargo fmt --all -- --check
```

The acceptance Worker and adapter checks are included in `.github/workflows/ci.yml`. The real runtime harness is `apps/web/scripts/acceptance-runtime-harness.mjs`; its `serve` mode runs on loopback and provides test-only account login routes. Those routes are absent from production Worker code.

## Deployment boundary

The [staged production deployment](acceptance-deployment-20260909.md) succeeded through apoc's `lv` profile after correcting workspace profile selection. The public and review Workers run source commit `4507426`; production migrations, Queues, and receipt keys are installed. Live health, JWKS, authentication boundaries, and disabled-gate behavior passed. Existing APNs secret bindings were retained.

`ACCEPTANCE_ENABLED` remains `false`. The launch still requires GitHub App configuration, real isolated previews and notification delivery, and the multi-account pilot described in [Acceptance Operations](acceptance-operations.md). The [day-30 audit](acceptance-30d-audit.md) keeps three hosted examples and an unaided new-team review unverified.
