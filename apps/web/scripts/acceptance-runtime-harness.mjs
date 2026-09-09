import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocalJWKSet, jwtVerify } from "jose";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";
import wrangler from "wrangler";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");
const ORIGIN = "https://nib.test";
const PROJECT_SUBJECT = "pr:runtime";
const PROJECT_GATE = "acceptance";
const { unstable_splitSqlQuery: splitSqlQuery } = wrangler;

async function main() {
  const command = process.argv[2] || "run";
  if (command === "run") {
    const result = await runScenario();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "serve") {
    const port = Number(process.argv[3] || process.env.PORT || 8798);
    await serveHarness(port);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

export async function runScenario(options = {}) {
  const runId = options.runId || crypto.randomUUID();
  const runtimeState = await createAcceptanceRuntime({ ...options, runId });
  const { mf, runtime, accounts, dispose } = runtimeState;
  try {
    const owner = runtime.as(accounts.owner.token);
    const reviewerA = runtime.as(accounts.reviewerA.token);
    const reviewerB = runtime.as(accounts.reviewerB.token);

    const team = await owner.post("/teams", { name: "Runtime Acceptance" }, "team-create", 201);
    const teamId = team.team.id;
    const invite = await owner.post(`/teams/${teamId}/invitations`, {
      email: accounts.invited.email,
      role: "member",
    }, "invite-create", 201);
    await runtime.as(accounts.invited.token).post(`/invitations/${invite.token}/accept`, {}, "invite-accept");

    const project = await owner.post(`/teams/${teamId}/projects`, {
      name: "Runtime Project",
      quorum: 2,
    }, "project-create", 201);
    const projectId = project.project.id;
    await owner.patch(`/projects/${projectId}/members/${accounts.reviewerA.accountId}`, { role: "reviewer" }, "reviewer-a");
    await owner.patch(`/projects/${projectId}/members/${accounts.reviewerB.accountId}`, { role: "reviewer" }, "reviewer-b");
    await owner.patch(`/projects/${projectId}/members/${accounts.invited.accountId}`, { role: "viewer" }, "invited-viewer");

    const evidence = await owner.uploadEvidence(projectId, "runtime evidence", "evidence-upload", "runtime.txt");
    const storedEvidence = await owner.fetchEvidence(projectId, evidence.sha256);
    assert(storedEvidence.status === 200, `stored evidence returned ${storedEvidence.status}`);
    assert(await storedEvidence.text() === "runtime evidence", "stored evidence body changed");

    const firstManifest = manifest(projectId, {
      title: "Runtime acceptance first",
      commit: "abc1230000000000000000000000000000000000",
      deploymentId: "deploy-runtime-1",
      versionId: "worker-runtime-1",
      evidence: [evidence],
    });
    const first = await owner.post(`/projects/${projectId}/reviews`, { manifest: firstManifest }, "publish-first", 201);
    assert(first.state === "pending", `first review state was ${first.state}`);

    const commentResult = await reviewerA.post(`/projects/${projectId}/reviews/${first.id}/comments`, {
      text: "Comment should not settle the review",
    }, "comment-first");
    assert(commentResult.state === "pending", `comment changed state to ${commentResult.state}`);

    const oneApproval = await reviewerA.post(`/projects/${projectId}/reviews/${first.id}/decisions`, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-b"],
    }, "approve-first-a");
    assert(oneApproval.state === "pending", `one approval reached quorum: ${oneApproval.state}`);

    await owner.patch(`/projects/${projectId}/members/${accounts.reviewerA.accountId}`, { role: "viewer" }, "revoke-reviewer-a");
    const afterRevocation = await owner.get(`/projects/${projectId}/reviews/${first.id}`);
    assert(afterRevocation.votes.length === 0, `revoked pending vote was retained: ${afterRevocation.votes.length}`);
    const revokedVerify = await owner.post(`/projects/${projectId}/reviews/${first.id}/verify`, {
      manifestHash: first.manifestHash,
      commit: firstManifest.build.commit,
      subject: PROJECT_SUBJECT,
      gate: PROJECT_GATE,
    }, "verify-revoked");
    assert(revokedVerify.satisfied === false && revokedVerify.reason === "not_approved", `revoked verify result was ${JSON.stringify(revokedVerify)}`);

    await owner.patch(`/projects/${projectId}/members/${accounts.reviewerA.accountId}`, { role: "reviewer" }, "restore-reviewer-a");
    const secondManifest = manifest(projectId, {
      title: "Runtime acceptance second",
      commit: "def4560000000000000000000000000000000000",
      deploymentId: "deploy-runtime-2",
      versionId: "worker-runtime-2",
      evidence: [evidence],
    });
    const second = await owner.post(`/projects/${projectId}/reviews`, { manifest: secondManifest }, "publish-second", 201);
    assert(second.revision === 2, `second revision was ${second.revision}`);
    const supersededFirst = await owner.get(`/projects/${projectId}/reviews/${first.id}`);
    assert(supersededFirst.state === "superseded", `first review after second publish was ${supersededFirst.state}`);

    const [voteA, voteB] = await Promise.all([
      reviewerA.post(`/projects/${projectId}/reviews/${second.id}/decisions`, {
        decision: "approve",
        criteriaIds: ["criterion-a", "criterion-b"],
      }, "approve-second-a"),
      reviewerB.post(`/projects/${projectId}/reviews/${second.id}/decisions`, {
        decision: "approve",
        criteriaIds: ["criterion-a", "criterion-b"],
      }, "approve-second-b"),
    ]);
    const approved = voteA.state === "approved" ? voteA : voteB;
    assert(approved.state === "approved", `concurrent quorum never approved: ${voteA.state}/${voteB.state}`);
    assert(approved.votes.length === 2, `concurrent quorum stored ${approved.votes.length} votes`);
    assert(new Set(approved.votes.map((vote) => vote.actorId)).size === 2, "concurrent quorum did not store two distinct voters");
    assert(typeof approved.receipt === "string" && approved.receipt.length > 40, "approved review did not include a receipt");

    const jwks = await runtime.jwks();
    const receiptPayload = await verifyReceipt(approved.receipt, jwks, approved.manifestHash);
    assert(receiptPayload.payload.projectId === projectId, "receipt project mismatch");
    assert(receiptPayload.payload.reviewId === second.id, "receipt review mismatch");
    assert(receiptPayload.payload.approvals.length === 2, `receipt approvals length was ${receiptPayload.payload.approvals.length}`);

    const current = await owner.get(`/projects/${projectId}/current?subject=${encodeURIComponent(PROJECT_SUBJECT)}&gate=${encodeURIComponent(PROJECT_GATE)}`);
    assert(current.id === second.id && current.state === "approved", `current review was ${JSON.stringify(current)}`);
    const satisfied = await owner.post(`/projects/${projectId}/reviews/${second.id}/verify`, {
      manifestHash: second.manifestHash,
      commit: secondManifest.build.commit,
      subject: PROJECT_SUBJECT,
      gate: PROJECT_GATE,
    }, "verify-approved");
    assert(satisfied.satisfied === true, `approved verify was ${JSON.stringify(satisfied)}`);
    const staleBuild = await owner.post(`/projects/${projectId}/reviews/${second.id}/verify`, {
      manifestHash: second.manifestHash,
      commit: "abc1230000000000000000000000000000000000",
      subject: PROJECT_SUBJECT,
      gate: PROJECT_GATE,
    }, "verify-stale-build");
    assert(staleBuild.satisfied === false && staleBuild.reason === "commit_mismatch", `stale build verify was ${JSON.stringify(staleBuild)}`);

    const thirdManifest = manifest(projectId, {
      title: "Runtime acceptance exact build replacement",
      commit: secondManifest.build.commit,
      deploymentId: secondManifest.build.deployment.id,
      versionId: secondManifest.build.deployment.components[0].versionId,
      request: "same build needs fresh review",
      evidence: [evidence],
    });
    const [raceComment, third] = await Promise.allSettled([
      reviewerA.post(`/projects/${projectId}/reviews/${second.id}/comments`, {
        text: "This race must not revive the old current review",
      }, "race-comment-old"),
      owner.post(`/projects/${projectId}/reviews`, { manifest: thirdManifest }, "publish-third", 201),
    ]);
    assert(third.status === "fulfilled", `race publish failed: ${settledReason(third)}`);
    const thirdReview = third.value;
    assert(thirdReview.revision === 3, `third revision was ${thirdReview.revision}`);
    const oldAfterRace = await owner.get(`/projects/${projectId}/reviews/${second.id}`);
    const currentAfterRace = await owner.get(`/projects/${projectId}/current?subject=${encodeURIComponent(PROJECT_SUBJECT)}&gate=${encodeURIComponent(PROJECT_GATE)}`);
    assert(oldAfterRace.state === "superseded", `old review after race was ${oldAfterRace.state}`);
    assert(currentAfterRace.id === thirdReview.id && currentAfterRace.state === "pending", `current after race was ${JSON.stringify(currentAfterRace)}`);
    const oldExactBuildVerify = await owner.post(`/projects/${projectId}/reviews/${second.id}/verify`, {
      manifestHash: second.manifestHash,
      commit: secondManifest.build.commit,
      subject: PROJECT_SUBJECT,
      gate: PROJECT_GATE,
    }, "verify-superseded-exact-build");
    assert(oldExactBuildVerify.satisfied === false && oldExactBuildVerify.reason === "not_current", `exact-build supersede verify was ${JSON.stringify(oldExactBuildVerify)}`);
    if (raceComment.status === "fulfilled") {
      assert(["pending", "approved", "superseded"].includes(raceComment.value.state), `unexpected race comment state ${raceComment.value.state}`);
    } else {
      assert(String(raceComment.reason).includes("409"), `race comment failed unexpectedly: ${raceComment.reason}`);
    }

    const storageBeforeRestart = await doStorageSummary(mf, projectId);
    assert(storageBeforeRestart.reviews.length >= 3, `DO stored only ${storageBeforeRestart.reviews.length} reviews`);
    assert(storageBeforeRestart.outboxCount > 0, "DO outbox had no persisted mutation events before restart");

    await mf.unsafeEvictDurableObject("nib", "AcceptanceCoordinator", { name: `project:${projectId}` });
    const currentAfterEvict = await owner.get(`/projects/${projectId}/current?subject=${encodeURIComponent(PROJECT_SUBJECT)}&gate=${encodeURIComponent(PROJECT_GATE)}`);
    assert(currentAfterEvict.id === thirdReview.id, "current review did not survive Durable Object eviction");
    const storageAfterEvict = await doStorageSummary(mf, projectId);
    assert(storageAfterEvict.outboxCount >= storageBeforeRestart.outboxCount, "outbox shrank during eviction without queue delivery proof");

    return {
      ok: true,
      runtime: "miniflare-workerd",
      projectId,
      teamId,
      reviewIds: [first.id, second.id, thirdReview.id],
      approvedReviewId: second.id,
      manifestHashes: [first.manifestHash, second.manifestHash, thirdReview.manifestHash],
      receipt: {
        kid: receiptPayload.header.kid,
        approvals: receiptPayload.payload.approvals.length,
        manifestHash: receiptPayload.payload.manifestHash,
      },
      revocation: { state: afterRevocation.state, votes: afterRevocation.votes.length, verify: revokedVerify.reason },
      concurrency: { voteStates: [voteA.state, voteB.state], voteCount: approved.votes.length },
      race: { comment: raceComment.status, current: currentAfterRace.id, oldState: oldAfterRace.state },
      persistence: { before: storageBeforeRestart, afterEvict: storageAfterEvict },
      d1: await d1Summary(mf),
      r2: { evidenceStatus: storedEvidence.status, evidenceSha256: evidence.sha256 },
    };
  } finally {
    await dispose();
  }
}

async function serveHarness(port) {
  const runtime = await createRuntime({ keep: true });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/__acceptance-runtime.json") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(runtime.state, null, 2));
        return;
      }
      const login = request.url?.match(/^\/__acceptance-runtime\/login\/([a-zA-Z]+)$/);
      if (login) {
        const role = login[1];
        const account = runtime.state.accounts[role];
        if (!account) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("Unknown runtime account");
          return;
        }
        response.writeHead(302, {
          "set-cookie": `nib_session=${encodeURIComponent(account.token)}; Path=/; HttpOnly; SameSite=Lax`,
          location: runtime.state.reviewUrl,
        });
        response.end();
        return;
      }
      await proxyToRuntime(runtime.mf, request, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><title>Acceptance Runtime Harness</title><style>body{font:14px/1.4 system-ui;margin:24px;max-width:1200px}pre{background:#111;color:#eee;padding:16px;overflow:auto;border-radius:6px}.fail{color:#b00020}</style><h1>Acceptance Runtime Harness</h1><p class="fail">Failed.</p><pre>${escapeHtml(error.stack || String(error))}</pre>`);
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`Acceptance runtime harness listening on http://127.0.0.1:${port}`);
  console.log(JSON.stringify({
    admin: `http://127.0.0.1:${port}/acceptance`,
    review: `http://127.0.0.1:${port}/acceptance/projects/${runtime.state.projectId}/reviews/${runtime.state.reviewId}`,
    accounts: Object.fromEntries(Object.entries(runtime.state.accounts).map(([role, account]) => [
      role,
      { email: account.email, loginUrl: `http://127.0.0.1:${port}/__acceptance-runtime/login/${role}` },
    ])),
  }, null, 2));
}

export async function createRuntime(options = {}) {
  const runtimeState = await createAcceptanceRuntime(options);
  const { mf, runtime, accounts, tempRoot } = runtimeState;
  const owner = runtime.as(accounts.owner.token);
  const team = await owner.post("/teams", { name: "Runtime Browser Team" }, "browser-team-create", 201);
  const teamId = team.team.id;
  await owner.patch(`/teams/${teamId}/members/${accounts.reviewerA.accountId}`, { role: "member" }, "browser-team-reviewer-a");
  await owner.patch(`/teams/${teamId}/members/${accounts.reviewerB.accountId}`, { role: "member" }, "browser-team-reviewer-b");
  await owner.patch(`/teams/${teamId}/members/${accounts.invited.accountId}`, { role: "member" }, "browser-team-viewer");
  const project = await owner.post(`/teams/${teamId}/projects`, { name: "Runtime Browser Project", quorum: 2 }, "browser-project-create", 201);
  const projectId = project.project.id;
  await owner.patch(`/projects/${projectId}/members/${accounts.reviewerA.accountId}`, { role: "reviewer" }, "browser-project-reviewer-a");
  await owner.patch(`/projects/${projectId}/members/${accounts.reviewerB.accountId}`, { role: "reviewer" }, "browser-project-reviewer-b");
  await owner.patch(`/projects/${projectId}/members/${accounts.invited.accountId}`, { role: "viewer" }, "browser-project-viewer");
  const evidence = await owner.uploadEvidence(projectId, "runtime browser evidence", "browser-evidence-upload", "browser-runtime.txt");
  const review = await owner.post(`/projects/${projectId}/reviews`, {
    manifest: manifest(projectId, {
      title: "Runtime browser review",
      commit: "feed000000000000000000000000000000000000",
      deploymentId: "deploy-runtime-browser",
      versionId: "worker-runtime-browser",
      evidence: [evidence],
    }),
  }, "browser-publish-review", 201);
  const state = {
    origin: ORIGIN,
    teamId,
    projectId,
    reviewId: review.id,
    reviewUrl: `/acceptance/projects/${projectId}/reviews/${review.id}`,
    apiReviewUrl: `/api/acceptance/v1/projects/${projectId}/reviews/${review.id}`,
    accounts,
  };
  process.once("SIGINT", async () => {
    await runtimeState.dispose();
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    await runtimeState.dispose();
    process.exit(143);
  });
  return { mf, state, tempRoot, dispose: runtimeState.dispose };
}

export async function createAcceptanceRuntime(options = {}) {
  const tempRoot = options.tempRoot || await mkdtemp(path.join(tmpdir(), "nib-acceptance-runtime-"));
  const runId = options.runId || crypto.randomUUID();
  const privateJwk = await generateSigningJwk();
  const bundlePath = await buildAcceptanceBundle(tempRoot);
  const mf = await createMiniflare(bundlePath, tempRoot, privateJwk);
  await applyD1Migrations(mf);
  const accounts = await seedAccounts(mf);
  const runtime = new RuntimeClient(mf, null, `runtime-${runId}`);
  await runtime.expectHealth();
  const bindingDebug = await runtime.bindingDebug();
  assert(bindingDebug.dbPrepareType === "function", `DB binding is not D1: ${JSON.stringify(bindingDebug)}`);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await mf.dispose();
    if (!options.keep && !options.tempRoot) await rm(tempRoot, { recursive: true, force: true });
  };
  return { mf, runtime, accounts, tempRoot, dispose };
}


export async function createFullWorkerRuntime(options = {}) {
  const tempRoot = options.tempRoot || await mkdtemp(path.join(tmpdir(), "nib-full-worker-runtime-"));
  let mf;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try { await mf?.dispose(); }
    finally {
      if (!options.keep && !options.tempRoot) await rm(tempRoot, { recursive: true, force: true });
    }
  };
  try {
    const runId = options.runId || crypto.randomUUID();
    const privateJwk = await generateSigningJwk();
    const bundles = await buildFullWorkerBundles(tempRoot);
    mf = await createFullWorkerMiniflare(bundles, tempRoot, privateJwk);
    await applyD1Migrations(mf);
    await (await mf.getD1Database("DB")).prepare("CREATE TABLE runtime_queue_sends(queue_name TEXT NOT NULL, body_json TEXT NOT NULL)").run();
    const accounts = await seedAccounts(mf);
    const runtime = new RuntimeClient(mf, null, `runtime-${runId}`);
    await runtime.expectHealth();
    const bindingDebug = await runtime.bindingDebug();
    assert(bindingDebug.dbPrepareType === "function", `DB binding is not D1: ${JSON.stringify(bindingDebug)}`);
    return { mf, runtime, accounts, tempRoot, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function proxyToRuntime(mf, request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name.toLowerCase() === "host") continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  const target = new URL(request.url || "/", ORIGIN);
  const workerResponse = await mf.dispatchFetch(target.toString(), {
    method: request.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const responseHeaders = {};
  workerResponse.headers.forEach((value, name) => { responseHeaders[name] = value; });
  response.writeHead(workerResponse.status, responseHeaders);
  response.end(Buffer.from(await workerResponse.arrayBuffer()));
}

async function buildFullWorkerBundles(tempRoot) {
  const publicWorker = path.join(tempRoot, "public-worker-entry.mjs");
  const reviewWorker = path.join(tempRoot, "review-worker-entry.mjs");
  const siteWorker = path.join(tempRoot, "site-worker-entry.mjs");

  await esbuild.build({
    stdin: {
      contents: `
        globalThis.fetch = async (input, init) => {
          const url = new URL(typeof input === "string" ? input : input.url);
          if (url.origin === "https://api.stripe.com") {
            if (url.pathname === "/v1/checkout/sessions") {
              return Response.json({ id: "cs_runtime", url: "https://checkout.stripe.test/session/cs_runtime" });
            }
            if (url.pathname === "/v1/billing_portal/sessions") {
              return Response.json({ id: "bps_runtime", url: "https://billing.stripe.test/session/bps_runtime" });
            }
            if (url.pathname.startsWith("/v1/subscriptions/")) {
              return Response.json({ id: "sub_runtime", status: "active" });
            }
            if (url.pathname === "/v1/billing/meter_events") {
              return Response.json({ id: "meter_runtime", created: true });
            }
          }
          if (url.origin === "https://image.runtime.test") {
            return new Response(Uint8Array.from([137,80,78,71,13,10,26,10]), { headers: { "content-type": "image/png" } });
          }
          throw new Error("Unexpected external request in local example: " + url.origin + url.pathname);
        };
        import worker, { AcceptanceCoordinator, GenerationScheduler, GenerationWorkflow, TenantGate, TrialGate } from "./worker/src/index.ts";
        export { AcceptanceCoordinator, GenerationScheduler, GenerationWorkflow, TenantGate, TrialGate };
        function runtimeEnv(env) {
          return {
            ...env,
            AI: env.AI || { async run() { return { image: "https://image.runtime.test/generated.png" }; } },
            METERING_QUEUE: {
              async send(body, options) {
                await env.METERING_QUEUE.send(body, options);
                await env.DB.prepare("INSERT INTO runtime_queue_sends(queue_name, body_json) VALUES (?, ?)")
                  .bind("nib-runtime-metering", JSON.stringify(body)).run();
              },
            },
            GENERATE_WORKFLOW: env.GENERATE_WORKFLOW || { async create(input) { return { id: input?.id || crypto.randomUUID(), status: "queued" }; } },
          };
        }
        export default {
          fetch(request, env, ctx) {
            if (new URL(request.url).pathname === "/__runtime_bindings") {
              const candidate = runtimeEnv(env);
              return Response.json({
                dbType: typeof env.DB,
                dbPrepareType: typeof env.DB?.prepare,
                aiRunType: typeof candidate.AI?.run,
                workflowCreateType: typeof candidate.GENERATE_WORKFLOW?.create,
                bindingKeys: Object.keys(candidate).sort(),
              });
            }
            return worker.fetch(request, runtimeEnv(env), ctx);
          },
          queue(batch, env) { return worker.queue?.(batch, runtimeEnv(env)); },
          scheduled(event, env, ctx) { return worker.scheduled?.(event, runtimeEnv(env), ctx); },
        };
      `,
      resolveDir: WEB_ROOT, sourcefile: "public-worker-entry.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", target: "es2024", outfile: publicWorker,
    external: ["cloudflare:workers", "node:*"], conditions: ["workerd", "worker", "browser"], logLevel: "silent",
    plugins: [cloudflareEmailPlugin()],
  });

  await esbuild.build({
    stdin: {
      contents: `
        import worker, { AccountReviewHub } from "../cloudflare/src/index.ts";
        export { AccountReviewHub };
        export default worker;
      `,
      resolveDir: WEB_ROOT, sourcefile: "review-worker-entry.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", target: "es2024", outfile: reviewWorker,
    external: ["cloudflare:workers"], conditions: ["workerd", "worker", "browser"], logLevel: "silent",
  });

  await esbuild.build({
    stdin: {
      contents: `export default { fetch() { return new Response("<!doctype html><title>Nib Test Site</title><main>Nib Test Site</main>", { headers: { "content-type": "text/html; charset=utf-8" } }); } };`,
      resolveDir: WEB_ROOT, sourcefile: "site-worker-entry.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", target: "es2024", outfile: siteWorker, logLevel: "silent",
  });

  return { publicWorker, reviewWorker, siteWorker };
}

async function buildAcceptanceBundle(tempRoot) {
  const outfile = path.join(tempRoot, "acceptance-runtime-entry.mjs");
  const entry = `
    import { handleAcceptanceRequest } from "./worker/src/acceptance/api.ts";
    import { AcceptanceCoordinator } from "./worker/src/acceptance/coordinator.ts";
    export { AcceptanceCoordinator };
    export default {
      async fetch(request, env) {
        if (new URL(request.url).pathname === "/health") {
          return Response.json({ ok: true, service: "acceptance-runtime" });
        }
        if (new URL(request.url).pathname === "/__runtime_bindings") {
          return Response.json({
            dbType: typeof env.DB,
            dbPrepareType: typeof env.DB?.prepare,
            bindingKeys: Object.keys(env).sort(),
          });
        }
        return await handleAcceptanceRequest(request, env) ?? new Response("Not found", { status: 404 });
      }
    };
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: WEB_ROOT, sourcefile: "acceptance-runtime-entry.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    outfile,
    external: ["cloudflare:workers"],
    plugins: [cloudflareEmailPlugin()],
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });
  return outfile;
}


function cloudflareEmailPlugin() {
  return {
    name: "acceptance-runtime-email",
    setup(build) {
      build.onResolve({ filter: /^cloudflare:email$/ }, () => ({
        path: "acceptance-runtime-email",
        namespace: "acceptance-runtime",
      }));
      build.onLoad({ filter: /.*/, namespace: "acceptance-runtime" }, () => ({
        contents: "export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }",
        loader: "js",
      }));
    },
  };
}

function baseRuntimeBindings(privateJwk) {
  return {
    ACCEPTANCE_ENABLED: "true",
    ACCEPTANCE_SIGNING_JWK: JSON.stringify(privateJwk),
    ACCEPTANCE_SIGNING_KEY_ID: "runtime-acceptance-key",
    PUBLIC_ORIGIN: ORIGIN,
    ENVIRONMENT: "test",
    AUTH_RATE_LIMIT_SECRET: "runtime-rate-secret",
    TRIAL_NETWORK_SECRET: "runtime-trial-secret",
    TRIAL_NETWORK_IDENTITIES_30D: "3",
    TRIAL_GLOBAL_DAILY_LIMIT: "50",
    STRIPE_SECRET_KEY: "sk_test_runtime",
    STRIPE_WEBHOOK_SECRET: "whsec_runtime",
    DEFAULT_PRICE_ID: "price_default",
    HIGH_PRICE_ID: "price_high",
    USAGE_PRICE_ID: "price_usage",
    STRIPE_USAGE_EVENT_NAME: "visualize_usage_cents",
    STRIPE_PORTAL_CONFIGURATION_ID: "bpc_runtime",
  };
}


async function createMiniflare(bundlePath, tempRoot, privateJwk) {
  const bindings = baseRuntimeBindings(privateJwk);
  return new Miniflare({
    name: "nib",
    scriptPath: bundlePath,
    modules: true,
    modulesRoot: tempRoot,
    rootPath: REPO_ROOT,
    compatibilityDate: "2026-08-02",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      ACCEPTANCE: { className: "AcceptanceCoordinator", useSQLite: true },
    },
    unsafeInspectDurableObjects: true,
    d1Databases: { DB: "nib-runtime-db" },
    r2Buckets: { ARTIFACTS: "nib-runtime-artifacts" },
    queueProducers: {
      ACCEPTANCE_EVENTS: { queueName: "nib-runtime-acceptance-events" },
      METERING_QUEUE: { queueName: "nib-runtime-metering" },
    },
    email: {
      send_email: [{ name: "EMAIL", allowed_sender_addresses: ["login@nibtool.com"] }],
    },
    serviceBindings: {
      REVIEW: async () => Response.json({ delivered: true }),
      SITE: async () => new Response("site"),
    },
    resourcePersistencePath: path.join(tempRoot, "miniflare"),
    bindings,
    queueConsumers: undefined,
  });
}


async function createFullWorkerMiniflare(bundles, tempRoot, privateJwk) {
  const bindings = { ...baseRuntimeBindings(privateJwk), ENVIRONMENT: "production" };
  return new Miniflare({
    rootPath: REPO_ROOT,
    compatibilityDate: "2026-08-02",
    compatibilityFlags: ["nodejs_compat"],
    unsafeInspectDurableObjects: true,
    resourcePersistencePath: path.join(tempRoot, "miniflare"),
    workers: [
      {
        name: "nib",
        scriptPath: bundles.publicWorker,
        compatibilityDate: "2026-08-02",
        compatibilityFlags: ["nodejs_compat"],
        modules: true,
        modulesRoot: tempRoot,
        durableObjects: {
          ACCEPTANCE: { className: "AcceptanceCoordinator", useSQLite: true },
          TENANT_GATE: { className: "TenantGate", useSQLite: true },
          SCHEDULER: { className: "GenerationScheduler", useSQLite: true },
          TRIAL_GATE: { className: "TrialGate", useSQLite: true },
        },
        d1Databases: { DB: "nib-runtime-db" },
        r2Buckets: { ARTIFACTS: "nib-runtime-artifacts" },
        queueProducers: {
          ACCEPTANCE_EVENTS: { queueName: "nib-runtime-acceptance-events" },
          METERING_QUEUE: { queueName: "nib-runtime-metering" },
        },
        serviceBindings: { REVIEW: "nib-global", SITE: "nib-site", ASSETS: "nib-site" },
        email: { send_email: [{ name: "EMAIL", allowed_sender_addresses: ["login@nibtool.com"] }] },
        bindings,
      },
      {
        name: "nib-global",
        scriptPath: bundles.reviewWorker,
        compatibilityDate: "2026-08-02",
        compatibilityFlags: ["nodejs_compat"],
        modules: true,
        modulesRoot: tempRoot,
        durableObjects: { REQUESTS: { className: "AccountReviewHub", useSQLite: true } },
        r2Buckets: { MEDIA: "nib-runtime-media" },
        bindings: { NIB_ACCEPTANCE_ORIGIN: ORIGIN },
      },
      {
        name: "nib-site",
        scriptPath: bundles.siteWorker,
        compatibilityDate: "2026-08-02",
        modules: true,
        modulesRoot: tempRoot,
      },
    ],
  });
}

async function applyD1Migrations(mf) {
  const db = await mf.getD1Database("DB");
  const migrationsDir = path.join(WEB_ROOT, "worker", "migrations");
  const migrations = [
    "0001_initial.sql",
    "0003_artifact_expiry.sql",
    "0004_free_trial.sql",
    "0005_cloudflare_usage.sql",
    "0006_accounts_and_magic_links.sql",
    "0007_account_deletion.sql",
    "0008_remove_legacy_private_request_tenants.sql",
    "0009_remove_legacy_customer_credentials.sql",
    "0010_hard_cut_accounts.sql",
    "0011_unmetered_accounts.sql",
    "0012_auth_email_codes.sql",
    "0013_billing_reconciliation.sql",
    "0014_metering_safe_retries.sql",
    "0015_acceptance_teams.sql",
    "0016_acceptance_integrations.sql",
    "0017_acceptance_delivery_and_evidence.sql",
    "0018_acceptance_usage.sql",
    "0019_acceptance_provider_verifications.sql",
  ];
  for (const migration of migrations) {
    const sql = await readFile(path.join(migrationsDir, migration), "utf8");
    for (const statement of splitSqlQuery(sql)) {
      const trimmed = statement.trim();
      if (trimmed) await db.prepare(trimmed).run();
    }
  }
}

async function seedAccounts(mf) {
  const db = await mf.getD1Database("DB");
  const now = Math.floor(Date.now() / 1000);
  const rows = {
    owner: { accountId: "10000000-0000-4000-8000-000000000001", email: "owner-runtime@example.com", token: "runtime-owner-token" },
    reviewerA: { accountId: "10000000-0000-4000-8000-000000000002", email: "reviewer-a-runtime@example.com", token: "runtime-reviewer-a-token" },
    reviewerB: { accountId: "10000000-0000-4000-8000-000000000003", email: "reviewer-b-runtime@example.com", token: "runtime-reviewer-b-token" },
    invited: { accountId: "10000000-0000-4000-8000-000000000004", email: "invited-runtime@example.com", token: "runtime-invited-token" },
  };
  for (const account of Object.values(rows)) {
    await db.prepare("INSERT INTO accounts(account_id, email, plan, created_at, updated_at) VALUES (?, ?, 'default', ?, ?)")
      .bind(account.accountId, account.email, now, now).run();
    await db.prepare("INSERT INTO auth_sessions(id, account_id, token_hash, name, platform, created_at, last_used_at) VALUES (?, ?, ?, 'runtime', 'web', ?, ?)")
      .bind(crypto.randomUUID(), account.accountId, await sha256(account.token), now, now).run();
  }
  return rows;
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

export class RuntimeClient {
  constructor(mf, token = null, idempotencyPrefix = "runtime") {
    this.mf = mf;
    this.token = token;
    this.idempotencyPrefix = idempotencyPrefix;
  }

  as(token) {
    return new RuntimeClient(this.mf, token, this.idempotencyPrefix);
  }

  async expectHealth() {
    const response = await dispatchWithTimeout(this.mf, `${ORIGIN}/health`);
    assert(response.status === 200, `health returned ${response.status}`);
  }

  async bindingDebug() {
    const response = await dispatchWithTimeout(this.mf, `${ORIGIN}/__runtime_bindings`);
    assert(response.status === 200, `binding debug returned ${response.status}`);
    return await response.json();
  }

  async jwks() {
    const response = await dispatchWithTimeout(this.mf, `${ORIGIN}/.well-known/acceptance-jwks.json`);
    assert(response.status === 200, `jwks returned ${response.status}`);
    return await response.json();
  }

  async get(pathname) {
    return await this.json("GET", pathname);
  }

  async post(pathname, body, key, expectedStatus = 200) {
    return await this.json("POST", pathname, body, key, expectedStatus);
  }

  async patch(pathname, body, key, expectedStatus = 200) {
    return await this.json("PATCH", pathname, body, key, expectedStatus);
  }

  async json(method, pathname, body, key, expectedStatus = 200) {
    const headers = new Headers({ accept: "application/json" });
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (key) headers.set("idempotency-key", `${this.idempotencyPrefix}-${key}`);
    const response = await dispatchWithTimeout(this.mf, `${ORIGIN}/api/acceptance/v1${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${method} ${pathname} returned non-JSON ${response.status}: ${text}`);
    }
    if (response.status !== expectedStatus) {
      throw new Error(`${method} ${pathname} returned ${response.status}, expected ${expectedStatus}: ${JSON.stringify(json)}`);
    }
    return json;
  }

  async uploadEvidence(projectId, body, key, filename) {
    const headers = new Headers({
      authorization: `Bearer ${this.token}`,
      "content-type": "text/plain",
      "idempotency-key": `${this.idempotencyPrefix}-${key}`,
      "x-nib-filename": filename,
    });
    const response = await dispatchWithTimeout(this.mf, `${ORIGIN}/api/acceptance/v1/projects/${projectId}/evidence`, {
      method: "POST",
      headers,
      body,
    });
    const json = await response.json();
    if (response.status !== 201) throw new Error(`POST evidence returned ${response.status}: ${JSON.stringify(json)}`);
    return json;
  }

  async fetchEvidence(projectId, digest) {
    return await dispatchWithTimeout(this.mf, `${ORIGIN}/api/acceptance/v1/projects/${projectId}/evidence/${digest}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
  }
}

export function manifest(projectId, overrides = {}) {
  const deployment = overrides.deployment || {
    id: overrides.deploymentId || "deploy-runtime",
    components: overrides.components || [{ name: "worker", versionId: overrides.versionId || "worker-runtime", kind: "worker" }],
    configSha256: overrides.configSha256 || "0".repeat(64),
    assetsSha256: overrides.assetsSha256 || "1".repeat(64),
  };
  return {
    contract: "nib.acceptance/v1",
    projectId,
    subject: overrides.subject || PROJECT_SUBJECT,
    gate: overrides.gate || PROJECT_GATE,
    title: overrides.title || "Runtime acceptance",
    request: overrides.request || "Ship the runtime acceptance packet",
    change: overrides.change || "Exercise team API, Durable Object review state, D1 metadata, and R2 evidence together.",
    criteria: overrides.criteria || [
      { id: "criterion-a", text: "First reviewer confirms the runtime behavior." },
      { id: "criterion-b", text: "Second reviewer confirms the runtime behavior." },
    ],
    build: {
      repository: overrides.repository || { id: "nib", owner: "douglance", name: "nib" },
      commit: overrides.commit || "abc1230000000000000000000000000000000000",
      provider: overrides.provider || "external",
      previewUrl: overrides.previewUrl || "https://preview.nib.test/runtime",
      deployment,
      assumptions: overrides.assumptions || ["Runtime validation uses local Miniflare resources."],
    },
    evidence: overrides.evidence || [],
  };
}

export async function doStorageSummary(mf, projectId) {
  const storage = await mf.unsafeGetDurableObjectStorage("nib", "AcceptanceCoordinator", { name: `project:${projectId}` });
  const reviews = await storage.exec("SELECT id, subject, gate, revision, record FROM acceptance_reviews ORDER BY revision");
  const outbox = await storage.exec("SELECT id, sequence, payload FROM acceptance_outbox ORDER BY sequence");
  const current = await storage.exec("SELECT subject, gate, review_id FROM acceptance_current");
  return {
    reviews: reviews.map((row) => ({ id: row.id, revision: row.revision, state: JSON.parse(row.record).state })),
    outboxCount: outbox.length,
    outboxStates: outbox.map((row) => JSON.parse(row.payload).state),
    current,
  };
}

export async function d1Summary(mf) {
  const db = await mf.getD1Database("DB");
  const tables = {};
  for (const table of ["accounts", "auth_sessions", "acceptance_teams", "acceptance_team_members", "acceptance_projects", "acceptance_project_members", "acceptance_evidence"]) {
    const result = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
    tables[table] = result.count;
  }
  return tables;
}

export async function verifyReceipt(receipt, jwks, manifestHash) {
  const result = await jwtVerify(receipt, createLocalJWKSet(jwks), {
    issuer: "nib.acceptance",
    audience: "nib.acceptance/receipt",
  });
  assert(result.payload.manifestHash === manifestHash, "receipt manifest hash mismatch");
  assert(result.protectedHeader.kid === "runtime-acceptance-key", "receipt key id mismatch");
  return { payload: result.payload, header: result.protectedHeader };
}

async function generateSigningJwk() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  privateJwk.alg = "EdDSA";
  privateJwk.kid = "runtime-acceptance-key";
  return privateJwk;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function settledReason(result) {
  return result.status === "rejected" ? result.reason?.stack || String(result.reason) : "";
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
