import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { manifestSha256, run } from "./index.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";

test("link mode submits GitHub OIDC ownership proof with setup token and skips workflow token exchange", async () => {
  const outputPath = path.join(await mkdtemp(path.join(tmpdir(), "nib-action-")), "output.txt");
  const calls = [];

  await run({
    env: actionEnv({
      "INPUT_MODE": "link",
      "INPUT_PROJECT-ID": projectId,
      "INPUT_API-ORIGIN": "https://nib.test",
      "INPUT_SETUP-TOKEN": "setup-token",
      "INPUT_INSTALLATION-ID": "456",
      "INPUT_ALLOWED-WORKFLOWS": "nib/example/.github/workflows/acceptance.yml@refs/heads/main",
      "INPUT_GATES": "acceptance,visual",
      "GITHUB_REPOSITORY_ID": "123",
      "GITHUB_REPOSITORY": "nib/example",
      "GITHUB_WORKFLOW_REF": "nib/example/.github/workflows/acceptance.yml@refs/heads/main",
      "GITHUB_OUTPUT": outputPath,
    }),
    fetch: fetchRecorder(calls, {
      link: { installation: { repository: { id: "123", owner: "nib", name: "example" }, enabled: true } },
    }),
  });

  const link = calls.find((call) => call.url === `https://nib.test/api/acceptance/v1/projects/${projectId}/integrations/github`);
  assert.equal(link.init.method, "PUT");
  assert.equal(link.init.headers.authorization, "Bearer setup-token");
  assert.match(link.init.headers["idempotency-key"], /^run-1:1:link:/);
  assert.deepEqual(JSON.parse(link.init.body), {
    installationId: "456",
    repositoryId: "123",
    owner: "nib",
    name: "example",
    allowedWorkflows: ["nib/example/.github/workflows/acceptance.yml@refs/heads/main"],
    gates: ["acceptance", "visual"],
    ownershipOidcToken: "oidc-token",
  });
  assert.equal(calls.some((call) => call.url.endsWith("/api/acceptance/v1/github/token")), false);
  const outputs = parseOutputs(await readFile(outputPath, "utf8"));
  assert.equal(outputs.state, "linked");
  assert.equal(outputs.repository, "nib/example");
});

test("link mode falls back to GITHUB_WORKFLOW_REF for allowed workflows", async () => {
  const calls = [];

  await run({
    env: actionEnv({
      "INPUT_MODE": "link",
      "INPUT_PROJECT-ID": projectId,
      "INPUT_API-ORIGIN": "https://nib.test",
      "INPUT_SETUP-TOKEN": "setup-token",
      "INPUT_INSTALLATION-ID": "456",
      "GITHUB_REPOSITORY_ID": "123",
      "GITHUB_REPOSITORY": "nib/example",
      "GITHUB_WORKFLOW_REF": "nib/example/.github/workflows/acceptance.yml@refs/heads/main",
    }),
    fetch: fetchRecorder(calls, {
      link: { installation: { repository: { id: "123", owner: "nib", name: "example" }, enabled: true } },
    }),
  });

  const link = calls.find((call) => call.url.endsWith("/integrations/github"));
  assert.deepEqual(JSON.parse(link.init.body).allowedWorkflows, ["nib/example/.github/workflows/acceptance.yml@refs/heads/main"]);
});

test("publish uses GitHub action input env names, verifies Cloudflare state, and writes a raw receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = cloudflareManifest();
  const state = cloudflareState(manifest);
  const manifestPath = path.join(root, "manifest.json");
  const statePath = path.join(root, "state.json");
  const outputPath = path.join(root, "output.txt");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(statePath, JSON.stringify(state));
  const calls = [];
  const hash = manifestSha256(manifest);

  await run({
    env: actionEnv({
      "INPUT_MODE": "publish",
      "INPUT_PROJECT-ID": projectId,
      "INPUT_API-ORIGIN": "https://nib.test",
      "INPUT_MANIFEST-PATH": manifestPath,
      "INPUT_CLOUDFLARE-STATE-PATH": statePath,
      "GITHUB_OUTPUT": outputPath,
    }),
    fetch: fetchRecorder(calls, {
      publish: { id: "review-1", reviewUrl: "https://nib.test/review-1", manifestHash: hash, state: "approved", receipt: "header.payload.signature" },
    }),
    cloudflareApi: exactCloudflareApi(manifest),
  });

  const exchange = calls.find((call) => call.url === "https://nib.test/api/acceptance/v1/github/token");
  assert.equal(JSON.parse(exchange.init.body).mode, "publish");
  assert.equal(JSON.parse(exchange.init.body).projectId, projectId);
  const publish = calls.find((call) => call.url === `https://nib.test/api/acceptance/v1/projects/${projectId}/reviews`);
  assert.equal(publish.init.headers.authorization, "Bearer workflow-token");
  assert.ok(publish.init.headers["idempotency-key"].endsWith(`:manifest:${hash}`));
  assert.deepEqual(JSON.parse(publish.init.body).manifest, manifest);
  const outputs = parseOutputs(await readFile(outputPath, "utf8"));
  assert.equal(outputs.receipt, "header.payload.signature");
  assert.equal(outputs["manifest-hash"], hash);
});

test("verify requires the manifest, posts the expected hash, and fails a false acceptance verdict", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = externalManifest();
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const hash = manifestSha256(manifest);
  const calls = [];

  await assert.rejects(
    run({
      env: actionEnv({
        "INPUT_MODE": "verify",
        "INPUT_PROJECT-ID": projectId,
        "INPUT_API-ORIGIN": "https://nib.test",
        "INPUT_REVIEW-ID": "review-1",
        "INPUT_MANIFEST-HASH": hash,
        "INPUT_MANIFEST-PATH": manifestPath,
        "GITHUB_SHA": manifest.build.commit,
      }),
      fetch: fetchRecorder(calls, {
        verify: { reviewId: "review-1", manifestHash: hash, state: "rejected", satisfied: false, reason: "manifest_hash_mismatch", receipt: null },
      }),
    }),
    /manifest_hash_mismatch/,
  );

  const verify = calls.find((call) => call.url.endsWith("/reviews/review-1/verify"));
  assert.deepEqual(JSON.parse(verify.init.body), { manifestHash: hash, commit: manifest.build.commit });
});

test("verify keeps pending reviews immediate by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = externalManifest();
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const hash = manifestSha256(manifest);
  const calls = [];
  const sleeps = [];

  await assert.rejects(
    run({
      env: actionEnv({
        "INPUT_MODE": "verify",
        "INPUT_PROJECT-ID": projectId,
        "INPUT_API-ORIGIN": "https://nib.test",
        "INPUT_REVIEW-ID": "review-1",
        "INPUT_MANIFEST-HASH": hash,
        "INPUT_MANIFEST-PATH": manifestPath,
        "GITHUB_SHA": manifest.build.commit,
      }),
      fetch: fetchRecorder(calls, {
        verify: { reviewId: "review-1", manifestHash: hash, state: "pending", satisfied: false, reason: "pending", receipt: null },
      }),
      sleep: async (ms) => sleeps.push(ms),
    }),
    /pending/,
  );

  assert.equal(calls.filter((call) => call.url.endsWith("/reviews/review-1/verify")).length, 1);
  assert.deepEqual(sleeps, []);
});

test("verify waits only while pending and bounds polls with monotonic time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = externalManifest();
  const manifestPath = path.join(root, "manifest.json");
  const outputPath = path.join(root, "output.txt");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const hash = manifestSha256(manifest);
  const calls = [];
  const sleeps = [];
  let now = 0;

  await run({
    env: actionEnv({
      "INPUT_MODE": "verify",
      "INPUT_PROJECT-ID": projectId,
      "INPUT_API-ORIGIN": "https://nib.test",
      "INPUT_REVIEW-ID": "review-1",
      "INPUT_MANIFEST-HASH": hash,
      "INPUT_MANIFEST-PATH": manifestPath,
      "INPUT_WAIT-TIMEOUT-SECONDS": "30",
      "GITHUB_SHA": manifest.build.commit,
      "GITHUB_OUTPUT": outputPath,
    }),
    fetch: fetchRecorder(calls, {
      verify: [
        { reviewId: "review-1", manifestHash: hash, state: "pending", satisfied: false, reason: "pending", receipt: null },
        { reviewId: "review-1", manifestHash: hash, state: "approved", satisfied: true, receipt: "header.payload.signature" },
      ],
    }),
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  assert.deepEqual(sleeps, [15_000]);
  assert.equal(calls.filter((call) => call.url.endsWith("/reviews/review-1/verify")).length, 2);
  assert.ok(calls.filter((call) => call.url.endsWith("/reviews/review-1/verify")).every((call) => call.init.signal));
  const outputs = parseOutputs(await readFile(outputPath, "utf8"));
  assert.equal(outputs.state, "approved");
  assert.equal(outputs.satisfied, "true");
});

test("verify positive wait uses the default native timeout signal without fractional RangeError", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = externalManifest();
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const hash = manifestSha256(manifest);
  const calls = [];

  await run({
    env: actionEnv({
      "INPUT_MODE": "verify",
      "INPUT_PROJECT-ID": projectId,
      "INPUT_API-ORIGIN": "https://nib.test",
      "INPUT_REVIEW-ID": "review-1",
      "INPUT_MANIFEST-HASH": hash,
      "INPUT_MANIFEST-PATH": manifestPath,
      "INPUT_WAIT-TIMEOUT-SECONDS": "1",
      "GITHUB_SHA": manifest.build.commit,
    }),
    fetch: fetchRecorder(calls, {
      verify: { reviewId: "review-1", manifestHash: hash, state: "approved", satisfied: true, receipt: "header.payload.signature" },
    }),
  });

  assert.ok(calls.find((call) => call.url.endsWith("/reviews/review-1/verify")).init.signal);
});

test("verify rejects wait timeouts that cannot be represented safely in milliseconds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = externalManifest();
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const hash = manifestSha256(manifest);

  await assert.rejects(
    run({
      env: actionEnv({
        "INPUT_MODE": "verify",
        "INPUT_PROJECT-ID": projectId,
        "INPUT_API-ORIGIN": "https://nib.test",
        "INPUT_REVIEW-ID": "review-1",
        "INPUT_MANIFEST-HASH": hash,
        "INPUT_MANIFEST-PATH": manifestPath,
        "INPUT_WAIT-TIMEOUT-SECONDS": `${Number.MAX_SAFE_INTEGER}`,
        "GITHUB_SHA": manifest.build.commit,
      }),
      fetch: fetchRecorder([], {
        verify: { reviewId: "review-1", manifestHash: hash, state: "approved", satisfied: true, receipt: "header.payload.signature" },
      }),
    }),
    /non-negative safe integer/,
  );
});

test("verify times out pending reviews without another request past the monotonic deadline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = externalManifest();
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const hash = manifestSha256(manifest);
  const calls = [];
  const sleeps = [];
  let now = 0;

  await assert.rejects(
    run({
      env: actionEnv({
        "INPUT_MODE": "verify",
        "INPUT_PROJECT-ID": projectId,
        "INPUT_API-ORIGIN": "https://nib.test",
        "INPUT_REVIEW-ID": "review-1",
        "INPUT_MANIFEST-HASH": hash,
        "INPUT_MANIFEST-PATH": manifestPath,
        "INPUT_WAIT-TIMEOUT-SECONDS": "16",
        "GITHUB_SHA": manifest.build.commit,
      }),
      fetch: fetchRecorder(calls, {
        verify: [
          { reviewId: "review-1", manifestHash: hash, state: "pending", satisfied: false, reason: "pending", receipt: null },
          { reviewId: "review-1", manifestHash: hash, state: "pending", satisfied: false, reason: "pending", receipt: null },
          { reviewId: "review-1", manifestHash: hash, state: "approved", satisfied: true, receipt: "header.payload.signature" },
        ],
      }),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    }),
    /still pending after 16 seconds/,
  );

  assert.deepEqual(sleeps, [15_000, 1_000]);
  assert.equal(calls.filter((call) => call.url.endsWith("/reviews/review-1/verify")).length, 2);
});

test("verify refreshes OIDC during waits and changes workflow token idempotency keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = externalManifest();
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const hash = manifestSha256(manifest);
  const calls = [];
  let now = 0;

  await run({
    env: actionEnv({
      "INPUT_MODE": "verify",
      "INPUT_PROJECT-ID": projectId,
      "INPUT_API-ORIGIN": "https://nib.test",
      "INPUT_REVIEW-ID": "review-1",
      "INPUT_MANIFEST-HASH": hash,
      "INPUT_MANIFEST-PATH": manifestPath,
      "INPUT_WAIT-TIMEOUT-SECONDS": "30",
      "GITHUB_SHA": manifest.build.commit,
    }),
    fetch: fetchRecorder(calls, {
      oidc: ["oidc-token-1", "oidc-token-2"],
      token: ["workflow-token-1", "workflow-token-2"],
      verify: [
        { reviewId: "review-1", manifestHash: hash, state: "pending", satisfied: false, reason: "pending", receipt: null },
        { reviewId: "review-1", manifestHash: hash, state: "approved", satisfied: true, receipt: "header.payload.signature" },
      ],
    }),
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });

  const exchanges = calls.filter((call) => call.url.endsWith("/api/acceptance/v1/github/token"));
  assert.equal(exchanges.length, 2);
  assert.notEqual(exchanges[0].init.headers["idempotency-key"], exchanges[1].init.headers["idempotency-key"]);
  assert.deepEqual(exchanges.map((call) => JSON.parse(call.init.body).oidcToken), ["oidc-token-1", "oidc-token-2"]);
  assert.deepEqual(
    calls.filter((call) => call.url.endsWith("/reviews/review-1/verify")).map((call) => call.init.headers.authorization),
    ["Bearer workflow-token-1", "Bearer workflow-token-2"],
  );
});

test("verify refreshes Cloudflare attestation on the final approved poll", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = cloudflareManifest();
  const state = cloudflareState(manifest);
  const manifestPath = path.join(root, "manifest.json");
  const statePath = path.join(root, "state.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(statePath, JSON.stringify(state));
  const hash = manifestSha256(manifest);
  const calls = [];
  let now = 0;
  let providerChecks = 0;

  await run({
    env: actionEnv({
      "INPUT_MODE": "verify",
      "INPUT_PROJECT-ID": projectId,
      "INPUT_API-ORIGIN": "https://nib.test",
      "INPUT_REVIEW-ID": "review-1",
      "INPUT_MANIFEST-HASH": hash,
      "INPUT_MANIFEST-PATH": manifestPath,
      "INPUT_CLOUDFLARE-STATE-PATH": statePath,
      "INPUT_WAIT-TIMEOUT-SECONDS": "30",
      "GITHUB_SHA": manifest.build.commit,
    }),
    fetch: fetchRecorder(calls, {
      verify: [
        { reviewId: "review-1", manifestHash: hash, state: "pending", satisfied: false, reason: "pending", receipt: null },
        { reviewId: "review-1", manifestHash: hash, state: "approved", satisfied: true, receipt: "header.payload.signature" },
      ],
    }),
    cloudflareApi: {
      async getLatestDeployment() {
        providerChecks += 1;
        return { versions: [{ version_id: manifest.build.deployment.components[0].versionId, percentage: 100 }] };
      },
      async getWorkerVersion() { return { id: manifest.build.deployment.components[0].versionId }; },
      async getWorkerPreviewUrl() { return manifest.build.previewUrl; },
    },
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });

  assert.equal(providerChecks, 2);
  assert.ok(JSON.parse(calls.filter((call) => call.url.endsWith("/reviews/review-1/verify")).at(-1).init.body).deploymentVerification);
});

test("verify console fallback redacts a satisfied receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = externalManifest();
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const hash = manifestSha256(manifest);
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    await run({
      env: actionEnv({
        "INPUT_MODE": "verify",
        "INPUT_PROJECT-ID": projectId,
        "INPUT_API-ORIGIN": "https://nib.test",
        "INPUT_REVIEW-ID": "review-1",
        "INPUT_MANIFEST-HASH": hash,
        "INPUT_MANIFEST-PATH": manifestPath,
        "GITHUB_SHA": manifest.build.commit,
      }),
      fetch: fetchRecorder([], {
        verify: { reviewId: "review-1", manifestHash: hash, state: "approved", satisfied: true, receipt: "header.payload.signature" },
      }),
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs.includes("receipt=header.payload.signature"), false);
  assert.ok(logs.includes("receipt=[redacted]"));
});

test("verify cannot pass a satisfied acceptance response when Cloudflare verification fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = cloudflareManifest();
  const manifestPath = path.join(root, "manifest.json");
  const statePath = path.join(root, "state.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(statePath, JSON.stringify(cloudflareState(manifest)));
  const hash = manifestSha256(manifest);
  const calls = [];

  await assert.rejects(
    run({
      env: actionEnv({
        "INPUT_MODE": "verify",
        "INPUT_PROJECT-ID": projectId,
        "INPUT_API-ORIGIN": "https://nib.test",
        "INPUT_REVIEW-ID": "review-1",
        "INPUT_MANIFEST-HASH": hash,
        "INPUT_MANIFEST-PATH": manifestPath,
        "INPUT_CLOUDFLARE-STATE-PATH": statePath,
        "GITHUB_SHA": manifest.build.commit,
      }),
      fetch: fetchRecorder(calls, {
        verify: { reviewId: "review-1", manifestHash: hash, state: "approved", satisfied: true, receipt: "header.payload.signature" },
      }),
      cloudflareApi: wrongCloudflareApi(manifest),
    }),
    /Cloudflare manifest verification failed/,
  );
  assert.equal(calls.some((call) => call.url.endsWith("/reviews/review-1/verify")), false);
});

test("verify sends a fresh Cloudflare deployment attestation before acceptance verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = cloudflareManifest();
  const manifestPath = path.join(root, "manifest.json");
  const statePath = path.join(root, "state.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(statePath, JSON.stringify(cloudflareState(manifest)));
  const hash = manifestSha256(manifest);
  const calls = [];

  await run({
    env: actionEnv({
      "INPUT_MODE": "verify",
      "INPUT_PROJECT-ID": projectId,
      "INPUT_API-ORIGIN": "https://nib.test",
      "INPUT_REVIEW-ID": "review-1",
      "INPUT_MANIFEST-HASH": hash,
      "INPUT_MANIFEST-PATH": manifestPath,
      "INPUT_CLOUDFLARE-STATE-PATH": statePath,
      "GITHUB_SHA": manifest.build.commit,
    }),
    fetch: fetchRecorder(calls, {
      verify: { reviewId: "review-1", manifestHash: hash, state: "approved", satisfied: true, receipt: "header.payload.signature" },
    }),
    cloudflareApi: exactCloudflareApi(manifest),
  });

  const verify = calls.find((call) => call.url.endsWith("/reviews/review-1/verify"));
  const body = JSON.parse(verify.init.body);
  assert.equal(body.manifestHash, hash);
  assert.equal(body.commit, manifest.build.commit);
  assert.deepEqual(Object.keys(body.deploymentVerification).sort(), ["commit", "manifestHash", "verifiedAt"]);
  assert.equal(body.deploymentVerification.manifestHash, hash);
  assert.equal(body.deploymentVerification.commit, manifest.build.commit);
  assert.match(body.deploymentVerification.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(verify.init.headers["idempotency-key"].endsWith(`:${body.deploymentVerification.verifiedAt}`));
});

test("verify rejects an old artifact when expected commit differs from the manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nib-action-"));
  const manifest = externalManifest();
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const calls = [];

  await assert.rejects(
    run({
      env: actionEnv({
        "INPUT_MODE": "verify",
        "INPUT_PROJECT-ID": projectId,
        "INPUT_API-ORIGIN": "https://nib.test",
        "INPUT_REVIEW-ID": "review-1",
        "INPUT_MANIFEST-HASH": manifestSha256(manifest),
        "INPUT_MANIFEST-PATH": manifestPath,
        "GITHUB_SHA": "b".repeat(40),
      }),
      fetch: fetchRecorder(calls, {}),
    }),
    /Expected commit does not match manifest build commit/,
  );
  assert.equal(calls.some((call) => call.url.endsWith("/reviews/review-1/verify")), false);
});

function actionEnv(extra = {}) {
  return {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/id-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    GITHUB_RUN_ID: "run-1",
    GITHUB_RUN_ATTEMPT: "1",
    ...extra,
  };
}

function fetchRecorder(calls, responses) {
  const oidc = Array.isArray(responses.oidc) ? [...responses.oidc] : null;
  const token = Array.isArray(responses.token) ? [...responses.token] : null;
  const verify = Array.isArray(responses.verify) ? [...responses.verify] : null;
  return async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://actions.example/id-token")) {
      assert.equal(new URL(url).searchParams.get("audience"), "nib.acceptance/v1");
      assert.equal(init.headers.authorization, "Bearer request-token");
      return jsonResponse({ value: oidc?.shift() ?? "oidc-token" });
    }
    if (url.endsWith("/api/acceptance/v1/github/token")) return jsonResponse({ access_token: token?.shift() ?? "workflow-token" });
    if (url.endsWith("/integrations/github")) return jsonResponse(responses.link);
    if (url.endsWith("/verify")) return jsonResponse(verify?.shift() ?? responses.verify);
    return jsonResponse(responses.publish);
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function parseOutputs(text) {
  const outputs = {};
  const regex = /^([^=\n]+)<<nib\n([\s\S]*?)\nnib\n/gm;
  for (const match of text.matchAll(regex)) outputs[match[1]] = match[2];
  return outputs;
}

function cloudflareManifest() {
  return {
    contract: "nib.acceptance/v1",
    projectId,
    subject: "github:nib/example:pull/12",
    gate: "acceptance",
    title: "Acceptance",
    request: "Approve the change",
    change: "Deploy preview",
    criteria: [{ id: "preview", text: "Preview is exact" }],
    build: {
      repository: { id: "123", owner: "nib", name: "example" },
      commit: "a".repeat(40),
      provider: "cloudflare",
      previewUrl: "https://review-worker-acc-a.preview.workers.dev",
      deployment: { id: "stack:deployment", components: [{ name: "review-worker-acc-a", versionId: "version-1" }] },
      assumptions: [],
    },
    evidence: [],
  };
}

function externalManifest() {
  return { ...cloudflareManifest(), build: { ...cloudflareManifest().build, provider: "external" } };
}

function cloudflareState(manifest) {
  const state = {
    contract: "nib.cloudflare-preview/v1",
    stackSlug: "stack",
    planSha256: "plan",
    journalPlanSha256: "plan",
    manifestHash: manifestSha256(manifest),
    primaryComponent: "review-worker-acc-a",
    components: [{ name: "review-worker-acc-a", versionId: "version-1", stackSlug: "stack" }],
    resources: [],
    r2Objects: [],
  };
  state.ownershipSha256 = manifestSha256({
    stackSlug: state.stackSlug,
    planSha256: state.planSha256,
    journalPlanSha256: state.journalPlanSha256,
    manifestHash: state.manifestHash,
    primaryComponent: state.primaryComponent,
    components: state.components,
    resources: state.resources,
    r2Objects: state.r2Objects,
  });
  return state;
}

function exactCloudflareApi(manifest) {
  return {
    async getLatestDeployment() { return { versions: [{ version_id: manifest.build.deployment.components[0].versionId, percentage: 100 }] }; },
    async getWorkerVersion() { return { id: manifest.build.deployment.components[0].versionId }; },
    async getWorkerPreviewUrl() { return manifest.build.previewUrl; },
  };
}

function wrongCloudflareApi(manifest) {
  return {
    async getLatestDeployment() { return { versions: [{ version_id: `${manifest.build.deployment.components[0].versionId}-wrong`, percentage: 100 }] }; },
    async getWorkerVersion() { return { id: manifest.build.deployment.components[0].versionId }; },
    async getWorkerPreviewUrl() { return manifest.build.previewUrl; },
  };
}
