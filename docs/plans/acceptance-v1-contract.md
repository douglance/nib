# Acceptance v1 implementation contract

This is the coordination contract for the implementation. Existing visual reviews and billing remain separate. The public `apps/web` Worker owns acceptance auth, team metadata (D1), an AcceptanceCoordinator Durable Object per project, and private acceptance evidence (R2). The existing REVIEW service is used for account notification delivery only.

## Shared wire contract

- API prefix: `/api/acceptance/v1`.
- Team endpoints: `/teams`, `/teams/:teamId`, `/teams/:teamId/members`, `/teams/:teamId/members/:accountId`, `/teams/:teamId/invitations`, `/invitations/:token/accept`, `/teams/:teamId/transfer`, `/teams/:teamId/projects`.
- Project endpoints: `/projects/:projectId`, `/projects/:projectId/members`, `/projects/:projectId/members/:accountId`, `/projects/:projectId/credentials`, `/projects/:projectId/credentials/:credentialId`.
- Review endpoints: `/projects/:projectId/reviews` (GET list, POST publish), `/projects/:projectId/reviews/:reviewId` (GET), suffix `/comments`, `/decisions`, `/preview-open`, `/invalidate`, `/export`, `/verify`. Current status: `/projects/:projectId/current?subject=...&gate=...`.
- Pages: `/acceptance` team/project administration; `/acceptance/projects/:projectId/reviews/:reviewId` review. Public sharing is an explicit project setting and permits only sanitized reads. Mutations always authenticate. Default private.
- POST/PATCH/DELETE require `Idempotency-Key`. JSON errors: `{error:{code,message}}`.

Publish body is `{manifest}`. Manifest:
```ts
interface AcceptanceManifest {
  contract: "nib.acceptance/v1";
  projectId: string;
  subject: string;
  gate: string;
  title: string;
  request: string;
  change: string;
  criteria: {id: string; text: string; verification?: string}[];
  build: {
    repository?: {id: string; owner: string; name: string};
    commit: string;
    provider: "cloudflare" | "external";
    previewUrl: string;
    deployment: {id: string; components: {name: string; versionId: string; kind?: string}[]; configSha256?: string; assetsSha256?: string};
    assumptions: string[];
  };
  evidence: {id: string; kind: "image" | "video" | "test" | "document"; label: string; url?: string; sha256?: string; contentType?: string}[];
}
```

Review response fields: `id, projectId, subject, gate, revision, manifest, manifestHash, state, policy:{quorum,ttlSeconds}, eligibleReviewers, createdAt, expiresAt, publishedBy, votes, comments, receipt` plus lifecycle fields such as invalidation actor/time/reason and supersession target when present. State: `pending|approved|rejected|revision_requested|expired|superseded|invalidated`. Votes: `actorId,decision,comment,criteriaIds,createdAt`; comments: `id,actorId,text,createdAt`. Decision body: `{decision:"approve"|"reject"|"request_revision",comment?,criteriaIds:string[]}`. Comments body `{text}`. Invalidation `{reason}`. Verify `{manifestHash,commit?,subject?,gate?,deploymentVerification?:{manifestHash:string,commit:string,verifiedAt:string}}` returns `{satisfied:boolean,state,reason?,receipt,reviewId,revision,manifestHash}`; only a fresh/current approved record satisfies. For `build.provider: "cloudflare"`, success also requires a fresh provider verification for the exact review, manifest hash, and commit. Missing or expired freshness returns `satisfied:false` with `reason:"cloudflare_current_version_unverified"`. Exported `.nib` acceptance packets store the full server review snapshot append-only so discussion, policy, eligibility, and lifecycle fields survive without expanding receipt claims.

Evidence upload endpoint: `POST /projects/:projectId/evidence` accepts raw bytes up to 16 MiB with `Content-Type` `image/png`, `image/jpeg`, `image/webp`, `video/mp4`, `application/pdf`, `text/plain`, or `application/json`, plus optional `X-Nib-Filename`. The Worker buffers the body to compute SHA-256 before R2 storage, so larger evidence must be hosted externally and referenced by manifest `url` plus `sha256`. The Worker validates only same-origin Nib evidence URLs for project/digest binding and storage availability.

## Authorization module

`acceptance/teams.ts` exports `handleTeamRoutes(request,env,account):Promise<Response|null>`, `getProjectAccess(db,projectId,accountId):Promise<ProjectAccess|null>`, `listEligibleReviewers(db,projectId):Promise<string[]>`, `listProjectRecipients(db,projectId):Promise<{accountId:string,email:string}[]>`, `authenticateAutomation(db,token):Promise<AutomationActor|null>`.

ProjectAccess: `{projectId,teamId,role:"admin"|"reviewer"|"viewer",permissions:{read:boolean,publish:boolean,review:boolean,manage:boolean},policy:{quorum:number,ttlSeconds:number},publicRead:boolean,enabled:boolean}`. Team Owner/Admin inherit project admin; Team Member only explicit project membership. Project Admin and Reviewer can comment/vote; Viewer is read-only. Credentials are project-scoped with `publish|read|verify` scopes and cannot vote. AutomationActor: `{id,projectId,scopes:string[]}`.

Team/project metadata schema is owned by the team module. Integration configuration uses a separate migration and references `acceptance_projects(id)` and `acceptance_teams(id)`. IDs are UUID strings, accounts use existing `accounts.account_id`.

Provider verification schema is owned by `0019_acceptance_provider_verifications.sql`. It stores short-lived rows keyed by `(project_id, actor_id, idempotency_key)` with `review_id`, `manifest_hash`, `commit_sha`, `verified_at`, and `expires_at`.

## Durable coordinator

`acceptance/coordinator.ts` exports `AcceptanceCoordinator`; contracts and receipt functions live under `acceptance/`. Namespace binding `ACCEPTANCE`, keys `project:<projectId>`. Coordinator methods are internal RPC and cannot be routed directly from public input.

- `publish(manifest, context, idempotencyKey)` context `{actorId,eligibleReviewers,policy}`.
- `getReview(id, eligibleReviewers?)`, `listReviews(eligibleReviewers?)`, `getCurrent(subject,gate,eligibleReviewers?)`.
- `decide(id,input,{actorId,eligibleReviewers},key)`, `comment(id,text,actorId,key)`, `openPreview(id,actorId,key)`, `invalidate(id,reason,actorId,key)`.
- `verify(id,expected,eligibleReviewers?)` returns verification contract above.

The public API performs provider freshness outside the Durable Object. It first asks the coordinator to verify canonical review state. If that passes and `deploymentVerification` is present, `recordProviderVerification` accepts it only from project automation with `verify` scope, only for Cloudflare, only for the exact manifest hash and commit, and only when `verifiedAt` is no older than 60 seconds and no more than 5 seconds in the future. The API then requires `hasFreshProviderVerification` and rechecks the coordinator before returning success. Humans cannot attest provider state.

Each mutation atomically records state, idempotency result, and an outbox event. Terminal decisions cannot be edited; explicit invalidation/supersession changes current validity while retaining original receipt/history. Event `{id,type:"acceptance.changed",projectId,reviewId,subject,gate,revision,sequence,state,manifestHash,occurredAt,receipt,manifest}`. Binding `ACCEPTANCE_EVENTS` Queue. Outbox alarm flush retries. Team invitation create/resend uses a separate `acceptance_invitation_email_outbox` D1 table, drains up to 20 unsent invitation emails after the idempotent mutation batch succeeds, and is also drained by the minute cron only when `ACCEPTANCE_ENABLED === "true"`. The minute cron always handles customer webhook replay and stale GitHub check reconciliation. Signed JWS v1 uses Ed25519 only: `ACCEPTANCE_SIGNING_JWK` is a private OKP `crv:"Ed25519"` JWK, `ACCEPTANCE_SIGNING_KEY_ID` is the `kid`, and the protected header is `{alg:"EdDSA",kid,typ:"JWT"}`. `ACCEPTANCE_VERIFICATION_JWKS` may contain retained public Ed25519 keys for rotation; public key endpoint `/.well-known/acceptance-jwks.json` returns retained keys plus the current public key. Generate a local key with:
```sh
node -e 'crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]).then(k=>crypto.subtle.exportKey("jwk",k.privateKey)).then(j=>{j.alg="EdDSA";j.kid=crypto.randomUUID();console.log(JSON.stringify(j))})'
```
Offline receipt verification must validate the JWS signature, `iss:"nib.acceptance"`, `aud:"nib.acceptance/receipt"`, JWT time claims, `exp === expiresAt`, `nbf === createdAt`, `iat === approvedAt`, quorum-reaching `approvedAt`, and canonical `sha256(manifest) === manifestHash`. The receipt signs only its defined payload. Comments, private discussion, and lifecycle snapshots are preserved in the packet as historical record fields, not as signed receipt claims.

## Integration modules

`acceptance/integrations.ts` exports `handleIntegrationRoutes(request,env,account):Promise<Response|null>` and `deliverAcceptanceEvent(event,env):Promise<void>`. Routes under project prefix `/integrations/github`, `/webhooks`; incoming GitHub webhook `/api/acceptance/v1/github/webhook`; workflow exchange `/api/acceptance/v1/github/token`. GitHub authentication never permits arbitrary caller identity/repo claims. Installation linking requires an authenticated Nib project admin and a signed ownership OIDC proof from a push or manual workflow on the target repository's actual default branch; the Action's `link` mode supplies this proof before normal publish/verify token exchange is available.

Action input: `mode=publish|verify`, `project-id`, `manifest-path` for publish, `review-id` and expected `manifest-hash` / `commit` for verify. For Cloudflare manifests, verify mode runs the live provider probe before the API call and sends `deploymentVerification:{manifestHash,commit,verifiedAt}`. Outputs `review-id,review-url,manifest-hash,state,satisfied,receipt`. CLI source continues to own command names: `nib feedback --packet PATH`, `nib request get|wait|export|verify` with project selection. Machine output is JSON. `nib feedback --packet` uploads packaged evidence bytes before publishing and sends a derived manifest with server evidence URLs; the original packet stays immutable. Generic API/CLI verification for Cloudflare manifests passes only while a recent authorized provider attestation exists.

## Defaults and acceptance

One required approval; TTL 604800 seconds (configurable shorter only). Review policy/eligibility snapshot at publication; live membership revocation removes pending votes, no silent retroactive rewriting of settled history. Any veto before quorum settles blocked. Every criterion acknowledged on approval. Comments do not settle. Preview open is an event, never proof of human testing. New packet revision supersedes old approvals even with identical commit.

Team invitations expire after 7 days, hashed tokens, email-bound acceptance. Custom roles and SSO are deferred. Feature flag is project enabled plus global `ACCEPTANCE_ENABLED`; disabled gates fail closed. Offline verification is historical proof; live current verification is required for consequential gates.
