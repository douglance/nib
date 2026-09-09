import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFullWorkerRuntime, d1Summary, doStorageSummary, manifest, verifyReceipt } from "./acceptance-runtime-harness.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");
const EXAMPLES_ROOT = path.join(REPO_ROOT, "examples", "acceptance");
const DEFAULT_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DEFAULT_PREVIEW_BASE_URL = "https://preview.nib.test/examples";
const DEFAULT_REPOSITORY = { id: "nib", owner: "douglance", name: "nib" };
const EXAMPLE_NAMES = ["onboarding", "business-rules", "permissions"];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const names = options.example === "all" ? EXAMPLE_NAMES : [options.example];
  const startedAt = new Date().toISOString();
  const examples = [];
  for (const name of names) {
    examples.push(await runExample(name, options));
  }
  const result = {
    ok: examples.every((example) => example.ok),
    runtime: "miniflare-workerd",
    notificationTransport: "mocked-local-email-binding-and-mocked-apns-no-real-email-or-apns",
    startedAt,
    completedAt: new Date().toISOString(),
    examples,
  };
  if (options.output) {
    await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function runExample(name, options) {
  const recipe = await readRecipe(name);
  progress(name, "startup");
  const runtimeState = await createFullWorkerRuntime({ runId: `example-${name}-${crypto.randomUUID()}` });
  progress(name, "migrations-and-seed-complete");
  const { mf, runtime, accounts, dispose } = runtimeState;
  try {
    const owner = runtime.as(accounts.owner.token);
    const reviewerA = runtime.as(accounts.reviewerA.token);
    const reviewerB = runtime.as(accounts.reviewerB.token);
    const viewer = runtime.as(accounts.invited.token);
    const repository = {
      id: options.repositoryId,
      owner: options.repositoryOwner,
      name: options.repositoryName,
    };
    const common = { recipe, mf, runtime, accounts, owner, reviewerA, reviewerB, viewer, repository, options };
    if (name === "onboarding") return await runOnboarding(common);
    if (name === "business-rules") return await runBusinessRules(common);
    if (name === "permissions") return await runPermissions(common);
    throw new Error(`Unknown example: ${name}`);
  } finally {
    await dispose();
  }
}

async function runOnboarding(ctx) {
  progress("onboarding", "onboarding auth/publish/read");
  const { recipe, mf, runtime, accounts, owner, reviewerA, repository, options } = ctx;
  const appOwner = new PublicWorkerClient(mf, accounts.owner.token, `onboarding-app-${crypto.randomUUID()}`);
  const fixture = await readJson(path.join(EXAMPLES_ROOT, "onboarding", "review-request.json"));
  const { teamId, projectId } = await createProjectFixture(ctx, {
    teamName: "Example onboarding team",
    projectName: "Example onboarding project",
    quorum: 1,
    reviewerRoles: { reviewerA: "reviewer" },
  });

  const appRequest = await appOwner.postApp("/api/requests", {
    kind: "question",
    title: fixture.title || "Onboarding readiness",
    prompt: fixture.prompt || recipe.request,
    body: fixture.body || "Confirm onboarding delivery through the public Nib worker.",
    choices: fixture.choices || ["Approve", "Revise"],
    target: { projectId },
    source: "acceptance-example:onboarding",
    metadata: { contract: "nib.onboarding.acceptance/v1", projectId },
  }, 201);
  assert(appRequest.id && appRequest.status === "open", `onboarding app request was ${JSON.stringify(appRequest)}`);
  const appList = await appOwner.getApp("/api/requests");
  assert(Array.isArray(appList) && appList.some((item) => item.id === appRequest.id), "onboarding app request was not listed from the review service");
  const evidence = await owner.uploadEvidence(
    projectId,
    JSON.stringify({ fixture, appRequestId: appRequest.id, source: "examples/acceptance/onboarding/review-request.json" }, null, 2),
    "onboarding-request-evidence",
    "onboarding-request.json",
  );
  const verificationCredential = await owner.post(`/projects/${projectId}/credentials`, {
    name: "Example onboarding verifier",
    scopes: ["verify"],
  }, "onboarding-create-verifier", 201);
  const review = await owner.post(`/projects/${projectId}/reviews`, {
    manifest: exampleManifest(recipe, projectId, repository, options, [evidence], {
      title: fixture.title,
      request: "Confirm the onboarding review request was delivered through the public Nib worker and can be opened without production notifications.",
      deploymentId: "example-onboarding-local",
      versionId: "example-onboarding-worker",
    }),
  }, "onboarding-publish", 201);
  assert(review.state === "pending", `onboarding review should start pending, got ${review.state}`);
  assert(review.reviewUrl.includes(`/acceptance/projects/${projectId}/reviews/${review.id}`), "onboarding review URL does not address the published review");

  const page = await fetchPage(mf, review.reviewUrl, accounts.reviewerA.token);
  assert(page.status === 200, `review page returned ${page.status}`);
  assert(page.body.includes("Nib Acceptance"), "review page did not render the acceptance shell");

  await reviewerA.post(`/projects/${projectId}/reviews/${review.id}/viewed`, {}, "onboarding-viewed");
  await reviewerA.post(`/projects/${projectId}/reviews/${review.id}/preview-open`, {}, "onboarding-preview-open");
  const approved = await reviewerA.post(`/projects/${projectId}/reviews/${review.id}/decisions`, {
    decision: "approve",
    criteriaIds: recipe.criteria.map((criterion) => criterion.id),
  }, "onboarding-approve");
  assert(approved.state === "approved", `onboarding approval should satisfy quorum, got ${approved.state}`);
  const verified = await runtime.as(verificationCredential.token).post(`/projects/${projectId}/reviews/${review.id}/verify`, {
    manifestHash: approved.manifestHash,
    commit: options.commit,
    subject: recipe.subject,
    gate: recipe.gate,
  }, "onboarding-verify");
  assert(verified.satisfied === true, `onboarding verification failed: ${JSON.stringify(verified)}`);
  const metrics = await owner.get(`/projects/${projectId}/metrics`);
  assert(metrics.events.reviewPublished === 1, "onboarding publish metric missing");
  assert(metrics.events.reviewPageViewed === 1, "onboarding page-view metric missing");
  assert(metrics.events.previewOpened === 1, "onboarding preview-open metric missing");
  assert(metrics.events.reviewDecisionRecorded === 1, "onboarding decision metric missing");

  return evidenceResult("onboarding", {
    teamId,
    projectId,
    reviewId: review.id,
    reviewUrl: review.reviewUrl,
    state: approved.state,
    manifestHash: approved.manifestHash,
    verification: pick(verified, ["satisfied", "state", "reason"]),
    assertions: {
      publicWorkerRequestId: appRequest.id,
      publicWorkerRequestListed: true,
      mockedNotificationTransport: true,
      reviewPageStatus: page.status,
      reviewPageShellRendered: true,
      metrics: metrics.events,
    },
    d1: await d1Summary(mf),
    durableObject: await doStorageSummary(mf, projectId),
  });
}

async function runBusinessRules(ctx) {
  progress("business-rules", "billinggenerate");
  const { recipe, mf, runtime, accounts, owner, reviewerA, reviewerB, repository, options } = ctx;
  const appOwner = new PublicWorkerClient(mf, accounts.owner.token, `business-app-${crypto.randomUUID()}`);
  const usageFixture = await readJson(path.join(EXAMPLES_ROOT, "business-rules", "usage-fixture.json"));
  const { teamId, projectId } = await createProjectFixture(ctx, {
    teamName: "Example business rules team",
    projectName: "Example business rules project",
    quorum: 2,
    reviewerRoles: { reviewerA: "reviewer", reviewerB: "reviewer" },
  });

  const initialBilling = await appOwner.getApp("/billing/status");
  assert(initialBilling.subscribed === false && initialBilling.plan === "default", `initial billing status was ${JSON.stringify(initialBilling)}`);
  const invalidPlan = await appOwner.postApp("/billing/plan", { plan: "enterprise" }, 400);
  assert(invalidPlan.error === "invalid plan", `invalid plan response was ${JSON.stringify(invalidPlan)}`);
  const checkout = await appOwner.postApp("/billing/checkout", { plan: "high" });
  assert(String(checkout.url || "").startsWith("https://checkout.stripe.test/"), `checkout did not use mocked Stripe: ${JSON.stringify(checkout)}`);
  const db = await mf.getD1Database("DB");
  await db.prepare("UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = ?, stripe_recurring_item_id = ?, updated_at = unixepoch() WHERE account_id = ?")
    .bind("cus_runtime", "sub_runtime", "si_runtime", accounts.owner.accountId).run();
  const paidGeneration = await appOwner.postApp("/internal/v1/generate", generationRequest());
  assert(paidGeneration.job_id && paidGeneration.image?.data, `paid generation failed: ${JSON.stringify(paidGeneration)}`);
  const ledger = await db.prepare("SELECT identifier, account_id, usage_cents, state FROM usage_ledger WHERE account_id = ?").bind(accounts.owner.accountId).all();
  assert(ledger.results.length === 1 && ledger.results[0].state === "queued", `usage ledger was ${JSON.stringify(ledger.results)}`);
  const queued = await db.prepare("SELECT queue_name, body_json FROM runtime_queue_sends").all();
  assert(queued.results.length === 1 && queued.results[0].queue_name === "nib-runtime-metering", "metering did not reach the isolated queue binding");
  assert(JSON.parse(queued.results[0].body_json).identifier === ledger.results[0].identifier, "queued event does not identify the recorded usage");
  const trialLimit = await proveTrialNetworkLimit(mf);
  const evidence = await owner.uploadEvidence(
    projectId,
    JSON.stringify({ fixture: usageFixture, billing: initialBilling, invalidPlan, checkoutUrl: checkout.url, usageLedger: ledger.results, trialLimit, source: "examples/acceptance/business-rules/usage-fixture.json" }, null, 2),
    "business-rules-usage-evidence",
    "business-rules-usage.json",
  );
  const verificationCredential = await owner.post(`/projects/${projectId}/credentials`, {
    name: "Example business-rules verifier",
    scopes: ["verify"],
  }, "business-rules-create-verifier", 201);
  const first = await owner.post(`/projects/${projectId}/reviews`, {
    manifest: exampleManifest(recipe, projectId, repository, options, [evidence], {
      deploymentId: "example-business-rules-initial",
      versionId: "example-business-rules-worker-initial",
    }),
  }, "business-rules-publish-initial", 201);
  const revisionRequested = await reviewerA.post(`/projects/${projectId}/reviews/${first.id}/decisions`, {
    decision: "request_revision",
    comment: "Attach the queue-isolation evidence before approval.",
    criteriaIds: [recipe.criteria[1].id],
  }, "business-rules-request-revision");
  assert(revisionRequested.state === "revision_requested", `business rules first review should request revision, got ${revisionRequested.state}`);

  const queueEvidence = await owner.uploadEvidence(
    projectId,
    JSON.stringify({ queueSends: queued.results, usageLedgerState: ledger.results[0].state, trialLimit }, null, 2),
    "business-rules-queue-evidence",
    "business-rules-queue.json",
  );
  const second = await owner.post(`/projects/${projectId}/reviews`, {
    manifest: exampleManifest(recipe, projectId, repository, options, [evidence, queueEvidence], {
      request: "Approve the trial-limit and preview-metering evidence after revision.",
      deploymentId: "example-business-rules-final",
      versionId: "example-business-rules-worker-final",
    }),
  }, "business-rules-publish-final", 201);
  assert(second.revision === 2, `business rules second review should be revision 2, got ${second.revision}`);
  const old = await owner.get(`/projects/${projectId}/reviews/${first.id}`);
  assert(old.state === "superseded", `business rules first review should be superseded, got ${old.state}`);
  const [voteA, voteB] = await Promise.all([
    reviewerA.post(`/projects/${projectId}/reviews/${second.id}/decisions`, {
      decision: "approve",
      criteriaIds: recipe.criteria.map((criterion) => criterion.id),
    }, "business-rules-approve-a"),
    reviewerB.post(`/projects/${projectId}/reviews/${second.id}/decisions`, {
      decision: "approve",
      criteriaIds: recipe.criteria.map((criterion) => criterion.id),
    }, "business-rules-approve-b"),
  ]);
  const approved = voteA.state === "approved" ? voteA : voteB;
  assert(approved.state === "approved", `business rules quorum did not approve: ${voteA.state}/${voteB.state}`);
  assert(approved.votes.length === 2, `business rules stored ${approved.votes.length} votes`);
  assert(new Set(approved.votes.map((vote) => vote.actorId)).size === 2, "business rules approvals are not from two distinct reviewers");
  const jwks = await runtime.jwks();
  const receipt = await verifyReceipt(approved.receipt, jwks, approved.manifestHash);
  const verified = await runtime.as(verificationCredential.token).post(`/projects/${projectId}/reviews/${second.id}/verify`, {
    manifestHash: approved.manifestHash,
    commit: options.commit,
    subject: recipe.subject,
    gate: recipe.gate,
  }, "business-rules-verify");
  assert(verified.satisfied === true, `business rules verification failed: ${JSON.stringify(verified)}`);
  const metrics = await owner.get(`/projects/${projectId}/metrics`);
  assert(metrics.events.reviewPublished === 2, "business rules should publish two revisions");
  assert(metrics.events.reviewDecisionRecorded === 3, "business rules should record one revision request and two approvals");

  return evidenceResult("business-rules", {
    teamId,
    projectId,
    initialReviewId: first.id,
    approvedReviewId: second.id,
    oldState: old.state,
    state: approved.state,
    manifestHash: approved.manifestHash,
    receipt: { kid: receipt.header.kid, approvals: receipt.payload.approvals.length },
    verification: pick(verified, ["satisfied", "state", "reason"]),
    assertions: {
      trialFixtureNetworkIdentities: usageFixture.networkIdentities,
      trialLimitError: trialLimit.error,
      billingCheckoutMockedStripe: true,
      usageLedgerQueued: ledger.results.length,
      previewMeteringQueueOnly: true,
      revisionRequiredBeforeApproval: true,
      distinctApprovers: 2,
      metrics: metrics.events,
    },
    d1: await d1Summary(mf),
    durableObject: await doStorageSummary(mf, projectId),
  });
}

async function runPermissions(ctx) {
  progress("permissions", "permissionsteps");
  const { recipe, mf, runtime, accounts, owner, reviewerA, viewer, repository, options } = ctx;
  const appOwner = new PublicWorkerClient(mf, accounts.owner.token, `permissions-app-owner-${crypto.randomUUID()}`);
  const appViewer = new PublicWorkerClient(mf, accounts.invited.token, `permissions-app-viewer-${crypto.randomUUID()}`);
  const { teamId, projectId } = await createProjectFixture(ctx, {
    teamName: "Example permissions team",
    projectName: "Example permissions project",
    quorum: 1,
    reviewerRoles: { reviewerA: "reviewer", invited: "viewer" },
  });
  const ownerDevice = await appOwner.postApp("/api/devices", {
    name: "Acceptance iPhone", platform: "ios", pushKind: "apns", token: "runtime-device-token",
    apnsTopic: "com.douglance.nib", apnsEnvironment: "sandbox", capabilities: ["review-actions"],
  }, 201);
  assert(ownerDevice.id, `owner device registration failed: ${JSON.stringify(ownerDevice)}`);
  const viewerDevices = await appViewer.getApp("/api/devices");
  assert(Array.isArray(viewerDevices.devices) && viewerDevices.devices.length === 0, "viewer saw owner device state across accounts");
  const notifyStatus = await appOwner.getApp("/api/notifications/status");
  assert(notifyStatus.deviceCount === 1 && notifyStatus.nativeReady === false, `notification status was ${JSON.stringify(notifyStatus)}`);
  const credential = await owner.post(`/projects/${projectId}/credentials`, {
    name: "Example CI read and verify",
    scopes: ["read", "verify"],
  }, "permissions-create-read-verify-credential", 201);
  const publishCredential = await owner.post(`/projects/${projectId}/credentials`, {
    name: "Example CI publish and verify",
    scopes: ["publish", "verify"],
  }, "permissions-create-publish-verify-credential", 201);
  const evidence = await owner.uploadEvidence(
    projectId,
    JSON.stringify({ roles: { owner: "admin", reviewerA: "reviewer", invited: "viewer" }, automationScopes: credential.credential.scopes }, null, 2),
    "permissions-evidence",
    "permissions.json",
  );
  const review = await owner.post(`/projects/${projectId}/reviews`, {
    manifest: exampleManifest(recipe, projectId, repository, options, [evidence], {
      deploymentId: "example-permissions-local",
      versionId: "example-permissions-worker",
    }),
  }, "permissions-publish", 201);
  const viewerRead = await viewer.get(`/projects/${projectId}/reviews/${review.id}`);
  assert(viewerRead.access.role === "viewer", `viewer read returned role ${viewerRead.access?.role}`);
  const viewerVote = await viewer.post(`/projects/${projectId}/reviews/${review.id}/decisions`, {
    decision: "approve",
    criteriaIds: recipe.criteria.map((criterion) => criterion.id),
  }, "permissions-viewer-vote-denied", 403);
  assert(viewerVote.error?.code === "permission_denied", `viewer vote error was ${JSON.stringify(viewerVote)}`);
  const viewerPublish = await viewer.post(`/projects/${projectId}/reviews`, {
    manifest: exampleManifest(recipe, projectId, repository, options, [evidence]),
  }, "permissions-viewer-publish-denied", 403);
  assert(viewerPublish.error?.code === "permission_denied", `viewer publish error was ${JSON.stringify(viewerPublish)}`);
  const viewerCredential = await viewer.post(`/projects/${projectId}/credentials`, {
    name: "Viewer should not create credentials",
    scopes: ["verify"],
  }, "permissions-viewer-credential-denied", 403);
  assert(viewerCredential.error?.code === "forbidden", `viewer credential error was ${JSON.stringify(viewerCredential)}`);
  const viewerInvalidate = await viewer.post(`/projects/${projectId}/reviews/${review.id}/invalidate`, { reason: "Viewer must not invalidate" }, "permissions-viewer-invalidate-denied", 403);
  assert(viewerInvalidate.error?.code === "permission_denied", `viewer invalidation error was ${JSON.stringify(viewerInvalidate)}`);
  const tokenWithoutPublish = runtime.as(credential.token);
  const automationPublishDenied = await tokenWithoutPublish.post(`/projects/${projectId}/reviews`, {
    manifest: exampleManifest(recipe, projectId, repository, options, [evidence]),
  }, "permissions-automation-without-publish-denied", 403);
  assert(automationPublishDenied.error?.code === "permission_denied", `read/verify token publish error was ${JSON.stringify(automationPublishDenied)}`);
  const automationPublisher = runtime.as(publishCredential.token);
  const automationReview = await automationPublisher.post(`/projects/${projectId}/reviews`, {
    manifest: exampleManifest(recipe, projectId, repository, options, [evidence], {
      title: "Automation-published permissions review",
      deploymentId: "example-permissions-automation",
      versionId: "example-permissions-automation-worker",
    }),
  }, "permissions-automation-publish", 201);
  assert(automationReview.state === "pending", `automation-published review should be pending, got ${automationReview.state}`);
  const old = await owner.get(`/projects/${projectId}/reviews/${review.id}`);
  assert(old.state === "superseded", `human-published review should be superseded, got ${old.state}`);
  const approved = await reviewerA.post(`/projects/${projectId}/reviews/${automationReview.id}/decisions`, {
    decision: "approve",
    criteriaIds: recipe.criteria.map((criterion) => criterion.id),
  }, "permissions-reviewer-approve");
  assert(approved.state === "approved", `reviewer approval should approve quorum 1, got ${approved.state}`);
  const automationVerify = await automationPublisher.post(`/projects/${projectId}/reviews/${automationReview.id}/verify`, {
    manifestHash: approved.manifestHash,
    commit: options.commit,
    subject: recipe.subject,
    gate: recipe.gate,
  }, "permissions-automation-verify");
  assert(automationVerify.satisfied === true, `automation verify failed: ${JSON.stringify(automationVerify)}`);
  const metrics = await owner.get(`/projects/${projectId}/metrics`);
  assert(metrics.events.reviewPublished === 2, "permissions should publish human and automation reviews");
  assert(metrics.events.reviewDecisionRecorded === 1, "permissions should record one reviewer decision");

  return evidenceResult("permissions", {
    teamId,
    projectId,
    humanReviewId: review.id,
    automationReviewId: automationReview.id,
    state: approved.state,
    manifestHash: approved.manifestHash,
    verification: pick(automationVerify, ["satisfied", "state", "reason"]),
    assertions: {
      adminPublished: true,
      viewerReadRole: viewerRead.access.role,
      viewerVoteDenied: viewerVote.error.code,
      viewerPublishDenied: viewerPublish.error.code,
      viewerCredentialDenied: viewerCredential.error.code,
      viewerInvalidationDenied: viewerInvalidate.error.code,
      readVerifyTokenCannotPublish: automationPublishDenied.error.code,
      publicWorkerDeviceRegistered: true,
      publicWorkerNotificationStatus: { deviceCount: notifyStatus.deviceCount, nativeReady: notifyStatus.nativeReady },
      viewerDeviceIsolation: true,
      publicWorkerDeviceRegistered: true,
      publicWorkerNotificationStatus: { deviceCount: notifyStatus.deviceCount, nativeReady: notifyStatus.nativeReady },
      viewerDeviceIsolation: true,
      publishVerifyTokenCanPublish: true,
      automationVerifySatisfied: true,
      metrics: metrics.events,
    },
    accounts: {
      owner: accounts.owner.email,
      reviewer: accounts.reviewerA.email,
      viewer: accounts.invited.email,
    },
    d1: await d1Summary(mf),
    durableObject: await doStorageSummary(mf, projectId),
  });
}

async function createProjectFixture(ctx, input) {
  const { owner, accounts } = ctx;
  const team = await owner.post("/teams", { name: input.teamName }, `${slug(input.projectName)}-team`, 201);
  const teamId = team.team.id;
  for (const role of ["reviewerA", "reviewerB", "invited"]) {
    if (input.reviewerRoles[role]) {
      await owner.patch(`/teams/${teamId}/members/${accounts[role].accountId}`, { role: "member" }, `${slug(input.projectName)}-team-${role}`);
    }
  }
  const project = await owner.post(`/teams/${teamId}/projects`, {
    name: input.projectName,
    quorum: input.quorum,
    publicRead: false,
  }, `${slug(input.projectName)}-project`, 201);
  const projectId = project.project.id;
  for (const [role, projectRole] of Object.entries(input.reviewerRoles)) {
    await owner.patch(`/projects/${projectId}/members/${accounts[role].accountId}`, { role: projectRole }, `${slug(input.projectName)}-project-${role}`);
  }
  return { teamId, projectId };
}

function exampleManifest(recipe, projectId, repository, options, evidence, overrides = {}) {
  return manifest(projectId, {
    subject: recipe.subject,
    gate: recipe.gate,
    title: overrides.title || recipe.title,
    request: overrides.request || recipe.request,
    change: recipe.change,
    criteria: recipe.criteria.map(({ id, text }) => ({ id, text })),
    commit: options.commit,
    repository,
    previewUrl: options.previewBaseUrl,
    provider: "external",
    deploymentId: overrides.deploymentId || `example-${recipe.name || recipe.subject}`,
    versionId: overrides.versionId || `worker-${recipe.gate}`,
    evidence,
    assumptions: [
      "Local verification uses Miniflare/workerd with D1, R2, Durable Object storage, and mocked notification transports.",
      "Remote preview execution requires the same recipe parameters and configured Nib credentials.",
    ],
  });
}

async function fetchPage(mf, reviewUrl, token) {
  const response = await mf.dispatchFetch(new URL(reviewUrl).toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.text() };
}

async function readRecipe(name) {
  const recipe = await readJson(path.join(EXAMPLES_ROOT, name, "recipe.json"));
  return { ...recipe, name };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function evidenceResult(name, data) {
  return { ok: true, name, runtime: "miniflare-workerd", notificationTransport: "mocked", ...data };
}

function generationRequest() {
  return {
    prompt: "Acceptance billing smoke",
    references: [{ name: "pixel.png", mime_type: "image/png", data: "iVBORw0KGgo=" }],
    quality: "fast", aspect: "1:1", resolution: "1K", format: "png", background: false,
  };
}

async function proveTrialNetworkLimit(mf) {
  const outcomes = [];
  for (let index = 0; index < 4; index += 1) {
    const account = `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const token = `runtime-trial-token-${index}`;
    await seedRuntimeAccount(mf, account, `trial-${index}@example.invalid`, token, { plan: "default", trialState: "available" });
    const client = new PublicWorkerClient(mf, token, `trial-limit-${index}`);
    outcomes.push(await client.postApp("/internal/v1/generate", generationRequest(), index < 3 ? 200 : 429, { "cf-connecting-ip": "203.0.113.55" }));
  }
  const rejected = outcomes[3];
  assert(rejected.error === "FREE_TRIAL_NETWORK_LIMIT", `trial network limit response was ${JSON.stringify(rejected)}`);
  return { attempts: outcomes.length, successes: 3, error: rejected.error };
}

async function seedRuntimeAccount(mf, accountId, email, token, options = {}) {
  const db = await mf.getD1Database("DB");
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO accounts(account_id, email, plan, trial_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(accountId, email, options.plan || "default", options.trialState || "available", now, now).run();
  await db.prepare("INSERT INTO auth_sessions(id, account_id, token_hash, name, platform, created_at, last_used_at) VALUES (?, ?, ?, 'runtime', 'web', ?, ?)")
    .bind(crypto.randomUUID(), accountId, await sha256(token), now, now).run();
}

class PublicWorkerClient {
  constructor(mf, token = null, idempotencyPrefix = "app") {
    this.mf = mf; this.token = token; this.idempotencyPrefix = idempotencyPrefix; this.sequence = 0;
  }
  async getApp(pathname, expectedStatus = 200, extraHeaders = {}) {
    return await this.appJson("GET", pathname, undefined, expectedStatus, extraHeaders);
  }
  async postApp(pathname, body, expectedStatus = 200, extraHeaders = {}) {
    return await this.appJson("POST", pathname, body, expectedStatus, extraHeaders);
  }
  async appJson(method, pathname, body, expectedStatus = 200, extraHeaders = {}) {
    const headers = new Headers({ accept: "application/json", ...extraHeaders });
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (method !== "GET") headers.set("idempotency-key", `${this.idempotencyPrefix}-${++this.sequence}`);
    const response = await dispatchWithTimeout(this.mf, `${DEFAULT_ORIGIN}${pathname}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : null; }
    catch { throw new Error(`${method} ${pathname} returned non-JSON ${response.status}: ${text}`); }
    if (response.status !== expectedStatus) throw new Error(`${method} ${pathname} returned ${response.status}, expected ${expectedStatus}: ${JSON.stringify(json)}`);
    return json;
  }
}

const DEFAULT_ORIGIN = "https://nib.test";

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function progress(example, phase) {
  console.error(`[acceptance-example] ${example}: ${phase}`);
}

async function dispatchWithTimeout(mf, input, init, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      mf.dispatchFetch(input, init),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Miniflare request timed out: ${typeof input === "string" ? input : input.url}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(args) {
  const options = {
    example: "all",
    commit: process.env.NIB_ACCEPTANCE_COMMIT || DEFAULT_COMMIT,
    repositoryId: process.env.NIB_ACCEPTANCE_REPOSITORY_ID || DEFAULT_REPOSITORY.id,
    repositoryOwner: process.env.NIB_ACCEPTANCE_REPOSITORY_OWNER || DEFAULT_REPOSITORY.owner,
    repositoryName: process.env.NIB_ACCEPTANCE_REPOSITORY_NAME || DEFAULT_REPOSITORY.name,
    previewBaseUrl: process.env.NIB_ACCEPTANCE_PREVIEW_BASE_URL || DEFAULT_PREVIEW_BASE_URL,
    output: process.env.NIB_ACCEPTANCE_EXAMPLE_OUTPUT || "",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--example") options.example = requiredArg(args, ++index, arg);
    else if (arg === "--commit") options.commit = requiredArg(args, ++index, arg);
    else if (arg === "--repository-id") options.repositoryId = requiredArg(args, ++index, arg);
    else if (arg === "--repository-owner") options.repositoryOwner = requiredArg(args, ++index, arg);
    else if (arg === "--repository-name") options.repositoryName = requiredArg(args, ++index, arg);
    else if (arg === "--preview-base-url") options.previewBaseUrl = requiredArg(args, ++index, arg);
    else if (arg === "--output") options.output = requiredArg(args, ++index, arg);
    else if (arg === "--help" || arg === "-h") usage(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.example !== "all" && !EXAMPLE_NAMES.includes(options.example)) {
    throw new Error(`--example must be one of all, ${EXAMPLE_NAMES.join(", ")}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(options.commit)) throw new Error("--commit must be a 40-character hex SHA");
  return options;
}

function requiredArg(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(exitCode) {
  console.log(`Usage: node apps/web/scripts/acceptance-example-runner.mjs [options]\n\nOptions:\n  --example all|onboarding|business-rules|permissions\n  --commit SHA40\n  --repository-id ID\n  --repository-owner OWNER\n  --repository-name NAME\n  --preview-base-url URL\n  --output FILE\n`);
  process.exit(exitCode);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pick(object, keys) {
  const result = {};
  for (const key of keys) {
    if (object && Object.prototype.hasOwnProperty.call(object, key)) result[key] = object[key];
  }
  return result;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
