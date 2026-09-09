import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FakeCloudflareApi,
  LiveCloudflareApi,
  deployCloudflarePreview,
  planCloudflarePreview,
  teardownCloudflarePreview,
  verifyAcceptanceGateFromManifest,
  verifyCloudflareManifest,
} from "../src/cloudflare-preview.mjs";

test("CLI returns a failing exit status for an unsatisfied provider verification", async () => {
  const root = await fixtureRoot();
  const manifestPath = path.join(root, "invalid-manifest.json");
  const statePath = path.join(root, "invalid-state.json");
  await writeFile(manifestPath, "{}");
  await writeFile(statePath, "{}");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/nib-cloudflare-preview.mjs", import.meta.url)),
    "verify-cloudflare", "--manifest", manifestPath, "--state", statePath], {
    encoding: "utf8", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-unused-token" },
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { satisfied: false, reason: "manifest has no Cloudflare deployment components" });
});

test("dry-run plan is deterministic and does not call Cloudflare", async () => {
  const root = await fixtureRoot();
  const recipe = recipeFor(root);
  const api = new FakeCloudflareApi();
  const first = await deployCloudflarePreview(recipe, { root, api });
  const second = await deployCloudflarePreview(recipe, { root, api });
  assert.equal(first.dryRun, true);
  assert.equal(second.dryRun, true);
  assert.equal(first.plan.planSha256, second.plan.planSha256);
  assert.deepEqual(api.calls, []);
});

test("isolated stack rewrites service bindings and stateful resources", async () => {
  const root = await fixtureRoot();
  const recipe = recipeFor(root);
  recipe.cloudflare.components.find((component) => component.primary).vars = { ACCEPTANCE_ENABLED: "true" };
  const plan = await planCloudflarePreview(recipe, { root });
  const primary = plan.components.find((component) => component.role === "primary");
  const dependency = plan.components.find((component) => component.baseName === "review-worker");
  assert.equal(primary.generatedConfig.services[0].service, dependency.name);
  assert.equal(primary.generatedConfig.workers_dev, true);
  assert.equal(primary.generatedConfig.preview_urls, false);
  assert.equal(primary.generatedConfig.vars.ENVIRONMENT, "production");
  assert.equal(primary.generatedConfig.vars.ACCEPTANCE_ENABLED, "true");
  assert.equal(dependency.generatedConfig.workers_dev, false);
  assert.equal(dependency.generatedConfig.preview_urls, false);
  assert.equal(dependency.generatedConfig.vars.PUBLIC_ORIGIN, primary.generatedConfig.vars.PUBLIC_ORIGIN);
  assert.equal(dependency.generatedConfig.vars.NIB_ACCEPTANCE_ORIGIN, primary.generatedConfig.vars.PUBLIC_ORIGIN);
  assert.match(primary.generatedConfig.d1_databases[0].database_name, /-acc-/);
  assert.match(primary.generatedConfig.r2_buckets[0].bucket_name, /-acc-/);
  assert.match(primary.generatedConfig.queues.producers[0].queue, /-acc-/);
  assert.match(primary.generatedConfig.vars.PUBLIC_ORIGIN, /^https:\/\/onboarding-/);
  assert.match(primary.generatedConfig.vars.NIB_ACCEPTANCE_ORIGIN, /^https:\/\/onboarding-/);
  assert.equal(primary.generatedConfig.routes, undefined);
  assert.equal(primary.generatedConfig.send_email, undefined);
});

test("live apply refuses to silently overwrite an existing resource", async () => {
  const root = await fixtureRoot();
  const plan = await planCloudflarePreview(recipeFor(root), { root });
  const resource = plan.operations.find((operation) => operation.action === "create" && operation.type === "d1");
  const api = new FakeCloudflareApi({ resources: [{ type: "d1", name: resource.name }] });
  await assert.rejects(
    deployCloudflarePreview(recipeFor(root), { root, dryRun: false, allowLive: true, api }),
    /Refusing to overwrite existing Cloudflare d1 resource/
  );
  assert.deepEqual(api.calls.slice(0, 2), [["workerExists", plan.components[0].name], ["workerExists", plan.components[1].name]]);
  assert.equal(api.calls.some((call) => call[0] === "createResource"), false);
});

test("live apply refuses to overwrite an existing preview Worker script", async () => {
  const root = await fixtureRoot();
  const plan = await planCloudflarePreview(recipeFor(root), { root });
  const api = new FakeCloudflareApi({ workers: [plan.components[0].name] });
  await assert.rejects(
    deployCloudflarePreview(recipeFor(root), { root, dryRun: false, allowLive: true, api }),
    /Refusing to overwrite existing Cloudflare Worker/
  );
  assert.deepEqual(api.calls[0], ["workerExists", plan.components[0].name]);
  assert.equal(api.calls.some((call) => call[0] === "resourceExists"), false);
});

test("live apply requires owned D1 id proof before migrations", async () => {
  const root = await fixtureRoot();
  const stateDir = path.join(root, ".state");
  const plan = await planCloudflarePreview(recipeFor(root), { root, stateDir });
  await mkdir(plan.stateDir, { recursive: true });
  const d1Create = plan.operations.find((operation) => operation.action === "create" && operation.type === "d1");
  await writeFile(path.join(plan.stateDir, "journal.json"), `${JSON.stringify({
    contract: "nib.cloudflare-preview/v1",
    stackSlug: plan.stackSlug,
    planSha256: plan.planSha256,
    operations: [{
      key: d1Create.idempotencyKey,
      target: d1Create.name,
      action: "create",
      type: "d1",
      status: "succeeded",
      result: { type: "d1", name: d1Create.name },
    }],
  }, null, 2)}\n`);
  await assert.rejects(
    deployCloudflarePreview(recipeFor(root), { root, stateDir, dryRun: false, allowLive: true, api: new FakeCloudflareApi() }),
    /owned database id proof/
  );
});

test("live apply creates, seeds, deploys, and emits an exact manifest", async () => {
  const root = await fixtureRoot();
  const api = new FakeCloudflareApi();
  const result = await deployCloudflarePreview(recipeFor(root), { root, dryRun: false, allowLive: true, api });
  assert.equal(result.verification.satisfied, true);
  assert.equal(result.manifest.contract, "nib.acceptance/v1");
  assert.equal(result.manifest.build.provider, "cloudflare");
  assert.equal(result.manifest.build.deployment.components.length, 2);
  assert.match(result.manifest.build.previewUrl, /^https:\/\//);
  assert.match(result.manifest.build.previewUrl, /\.fake-subdomain\.workers\.dev$/);
  assert.equal(result.plan.components[0].generatedConfig.vars.PUBLIC_ORIGIN, result.manifest.build.previewUrl);
  assert.equal(result.plan.components[0].generatedConfig.vars.NIB_ACCEPTANCE_ORIGIN, result.manifest.build.previewUrl);
  assert.equal(result.plan.components[0].generatedConfig.preview_urls, false);
  assert.equal(result.plan.components[1].generatedConfig.workers_dev, false);
  assert.equal(result.plan.components[1].generatedConfig.preview_urls, false);
  assert.equal(result.plan.components[1].generatedConfig.vars.NIB_ACCEPTANCE_ORIGIN, result.manifest.build.previewUrl);
  assert.equal("resources" in result.manifest.build.deployment, false);
  assert.equal(result.state.resources.length > 0, true);
  assert.match(result.plan.components[0].generatedConfig.d1_databases[0].database_id, /^d1-/);
  const d1CreateIndex = api.calls.findIndex((call) => call[0] === "createResource" && call[1] === "d1");
  const migrateIndex = api.calls.findIndex((call) => call[0] === "applyD1Migrations");
  const seedIndex = api.calls.findIndex((call) => call[0] === "seedResource" && call[1] === "d1");
  assert.equal(d1CreateIndex >= 0, true);
  assert.equal(migrateIndex > d1CreateIndex, true);
  assert.equal(seedIndex > migrateIndex, true);
  const journal = JSON.parse(await readFile(result.state.journalPath, "utf8"));
  const migrationEntry = journal.operations.find((operation) => operation.action === "migrate" && operation.type === "d1");
  assert.equal(migrationEntry.result.databaseId, result.state.resources.find((resource) => resource.type === "d1").id);
  assert.deepEqual(
    api.calls.filter((call) => call[0] === "deployWorker").map((call) => call[1]),
    [result.plan.components[1].name, result.plan.components[0].name]
  );
});

test("verification fails when a service-binding dependency serves the wrong version", async () => {
  const root = await fixtureRoot();
  const api = new FakeCloudflareApi();
  const result = await deployCloudflarePreview(recipeFor(root), { root, dryRun: false, allowLive: true, api });
  const dependency = result.state.components.find((component) => component.name !== result.state.primaryComponent);
  api.deployments.set(dependency.name, {
    workerName: dependency.name,
    id: dependency.deploymentId,
    annotations: { "workers/message": "stale" },
    versions: [{ version_id: "other-version", percentage: 100 }],
  });
  const verification = await verifyCloudflareManifest(api, result.manifest, result.state);
  assert.equal(verification.satisfied, false);
  assert.match(verification.reason, /is not serving expected version/);
});

test("verification rejects empty manifests and missing ownership state", async () => {
  const api = new FakeCloudflareApi();
  const empty = {
    contract: "nib.acceptance/v1",
    build: { deployment: { components: [] } },
  };
  assert.equal((await verifyCloudflareManifest(api, empty, { contract: "nib.cloudflare-preview/v1" })).satisfied, false);
  const root = await fixtureRoot();
  const result = await deployCloudflarePreview(recipeFor(root), { root, dryRun: false, allowLive: true, api: new FakeCloudflareApi() });
  assert.equal((await verifyCloudflareManifest(api, result.manifest)).satisfied, false);
});

test("verification binds primary preview URL to the owned Worker URL", async () => {
  const root = await fixtureRoot();
  const api = new FakeCloudflareApi();
  const result = await deployCloudflarePreview(recipeFor(root), { root, dryRun: false, allowLive: true, api });
  result.manifest.build.previewUrl = "https://wrong-preview.example.com";
  const verification = await verifyCloudflareManifest(api, result.manifest, result.state);
  assert.equal(verification.satisfied, false);
  assert.match(verification.reason, /manifest hash/);
});

test("acceptance verification posts fresh Cloudflare deployment verification", async () => {
  const root = await fixtureRoot();
  const api = new FakeCloudflareApi();
  const result = await deployCloudflarePreview(recipeFor(root), { root, dryRun: false, allowLive: true, api });
  const requests = [];
  const response = await verifyAcceptanceGateFromManifest({
    acceptanceUrl: "https://acceptance.example/",
    token: "token",
    manifest: result.manifest,
    reviewId: "review-id",
    api,
    localState: result.state,
    now: () => new Date("2026-09-09T03:22:00.000Z"),
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse({ success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, satisfied: true, state: "current" });
    },
  });
  assert.equal(response.satisfied, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://acceptance.example/api/acceptance/v1/projects/project-alpha/reviews/review-id/verify");
  assert.equal(requests[0].body.manifestHash, result.state.manifestHash);
  assert.deepEqual(requests[0].body.deploymentVerification, {
    manifestHash: result.state.manifestHash,
    commit: "abc123",
    verifiedAt: "2026-09-09T03:22:00.000Z",
  });
  assert.match(requests[0].init.headers["Idempotency-Key"], /:verify:[a-f0-9]{64}$/);
});

test("acceptance verification fails before POST when Cloudflare verification fails", async () => {
  const root = await fixtureRoot();
  const api = new FakeCloudflareApi();
  const result = await deployCloudflarePreview(recipeFor(root), { root, dryRun: false, allowLive: true, api });
  result.manifest.build.previewUrl = "https://wrong-preview.example.com";
  let posted = false;
  await assert.rejects(
    verifyAcceptanceGateFromManifest({
      acceptanceUrl: "https://acceptance.example",
      token: "token",
      manifest: result.manifest,
      reviewId: "review-id",
      api,
      localState: result.state,
      fetchImpl: async () => {
        posted = true;
        return jsonResponse({ success: true });
      },
    }),
    /Cloudflare acceptance verification failed/
  );
  assert.equal(posted, false);
});

test("LiveCloudflareApi creates D1 through API and returns the real uuid", async () => {
  const calls = [];
  const api = new LiveCloudflareApi({
    accountId: "acct",
    apiToken: "token",
    runner: { run: async (argv) => calls.push(["runner", argv]) },
    fetchImpl: async (url, init) => {
      calls.push(["fetch", url, init.method, init.body]);
      return jsonResponse({ success: true, result: { uuid: "real-d1-uuid", name: "preview-db" } });
    },
  });
  const created = await api.createResource("d1", "preview-db", {});
  assert.equal(created.id, "real-d1-uuid");
  assert.equal(calls[0][2], "POST");
  assert.match(calls[0][1], /\/accounts\/acct\/d1\/database$/);
});

test("LiveCloudflareApi detects existing R2 buckets from API list shape", async () => {
  const api = new LiveCloudflareApi({
    accountId: "acct",
    apiToken: "token",
    runner: { run: async () => undefined },
    fetchImpl: async (url) => {
      assert.match(url, /\/accounts\/acct\/r2\/buckets$/);
      return jsonResponse({ success: true, result: { buckets: [{ name: "bucket-acc-owned" }] } });
    },
  });
  assert.equal(await api.resourceExists("r2", "bucket-acc-owned"), true);
  assert.equal(await api.resourceExists("r2", "other-bucket"), false);
});

test("LiveCloudflareApi applies D1 migrations through generated config", async () => {
  const runnerCalls = [];
  const api = new LiveCloudflareApi({
    accountId: "acct",
    apiToken: "token",
    runner: { run: async (argv) => runnerCalls.push(argv) },
    fetchImpl: async () => jsonResponse({ success: true, result: {} }),
  });
  await api.applyD1Migrations("db-acc-owned", {
    generatedConfigPath: "/tmp/generated.wrangler.jsonc",
    migrationsDir: "/repo/apps/web/worker/migrations",
    migrationsSha256: "abc",
  });
  assert.deepEqual(runnerCalls, [["d1", "migrations", "apply", "db-acc-owned", "--remote", "--config", "/tmp/generated.wrangler.jsonc"]]);
});

test("LiveCloudflareApi seeds D1 through generated config", async () => {
  const runnerCalls = [];
  const api = new LiveCloudflareApi({
    accountId: "acct",
    apiToken: "token",
    runner: { run: async (argv) => runnerCalls.push(argv) },
    fetchImpl: async () => jsonResponse({ success: true, result: {} }),
  });
  await api.seedResource("d1", "db-acc-owned", {
    file: "/repo/fixtures/seed.sql",
    generatedConfigPath: "/tmp/generated.wrangler.jsonc",
  });
  assert.deepEqual(runnerCalls, [["d1", "execute", "db-acc-owned", "--remote", "--file", "/repo/fixtures/seed.sql", "--config", "/tmp/generated.wrangler.jsonc", "-y"]]);
});

test("LiveCloudflareApi deploys Workers and records active version from API", async () => {
  const runnerCalls = [];
  const api = new LiveCloudflareApi({
    accountId: "acct",
    apiToken: "token",
    runner: { run: async (argv) => runnerCalls.push(argv) },
    fetchImpl: async (url) => {
      if (url.endsWith("/deployments")) {
        return jsonResponse({ success: true, result: [{ id: "deployment-id", annotations: { "workers/message": "preview" }, versions: [{ version_id: "version-id", percentage: 100 }] }] });
      }
      if (url.endsWith("/workers/subdomain")) {
        return jsonResponse({ success: true, result: { subdomain: "preview-subdomain" } });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  const deployed = await api.deployWorker({
    generatedConfigPath: "/tmp/wrangler.jsonc",
    name: "worker-acc-abc",
    versionTag: "acceptance-abc",
    message: "preview",
  });
  assert.deepEqual(runnerCalls[0], ["deploy", "--config", "/tmp/wrangler.jsonc", "--name", "worker-acc-abc", "--tag", "acceptance-abc", "--message", "preview"]);
  assert.equal(deployed.versionId, "version-id");
  assert.equal(deployed.previewUrl, "https://worker-acc-abc.preview-subdomain.workers.dev");
});

test("LiveCloudflareApi rejects latest deployment from a concurrent command", async () => {
  const api = new LiveCloudflareApi({
    accountId: "acct",
    apiToken: "token",
    runner: { run: async () => undefined },
    fetchImpl: async (url) => {
      if (url.endsWith("/deployments")) {
        return jsonResponse({ success: true, result: [{ id: "deployment-id", annotations: { "workers/message": "someone else" }, versions: [{ version_id: "version-id", percentage: 100 }] }] });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  await assert.rejects(
    api.deployWorker({
      generatedConfigPath: "/tmp/wrangler.jsonc",
      name: "worker-acc-abc",
      versionTag: "acceptance-abc",
      message: "preview",
    }),
    /concurrent deploy/
  );
});

test("LiveCloudflareApi seeds and deletes only owned R2 objects with remote operations", async () => {
  const runnerCalls = [];
  const api = new LiveCloudflareApi({
    accountId: "acct",
    apiToken: "token",
    runner: { run: async (argv) => runnerCalls.push(argv) },
    fetchImpl: async () => jsonResponse({ success: true, result: {} }),
  });
  await api.seedResource("r2", "bucket-acc-owned", { key: "fixture.json", file: "/tmp/fixture.json" });
  await api.deleteR2Object("bucket-acc-owned", "fixture.json");
  assert.deepEqual(runnerCalls, [
    ["r2", "object", "put", "bucket-acc-owned/fixture.json", "--file", "/tmp/fixture.json", "--remote"],
    ["r2", "object", "delete", "bucket-acc-owned/fixture.json", "--remote", "-y"],
  ]);
});

test("teardown requires invalidation proof and owned local state", async () => {
  const root = await fixtureRoot();
  const api = new FakeCloudflareApi();
  const result = await deployCloudflarePreview(recipeFor(root), { root, dryRun: false, allowLive: true, api });
  await assert.rejects(
    teardownCloudflarePreview(result.manifest, { allowLive: true, api }),
    /owned local preview state/
  );
  await assert.rejects(
    teardownCloudflarePreview(result.state, { allowLive: true, api }),
    /authenticated acceptance invalidation/
  );
  await assert.rejects(
    teardownCloudflarePreview(result.state, {
      allowLive: true,
      api,
      acceptanceUrl: "https://acceptance.example",
      token: "token",
      reviewId: "review-id",
      fetchImpl: async () => jsonResponse({ success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, revision: "abc123", satisfied: true, state: "invalidated" }),
    }),
    /still active/
  );
  await assert.rejects(
    teardownCloudflarePreview(result.state, {
      allowLive: true,
      api,
      acceptanceUrl: "https://acceptance.example",
      token: "token",
      reviewId: "review-id",
      fetchImpl: async () => jsonResponse({ success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, state: "pending" }),
    }),
    /did not return invalidated/
  );
  await assert.rejects(
    teardownCloudflarePreview(result.state, {
      allowLive: true,
      api,
      acceptanceUrl: "https://acceptance.example",
      token: "token",
      reviewId: "review-id",
      fetchImpl: async () => jsonResponse({ success: true, reviewId: "other-review", manifestHash: result.state.manifestHash, state: "invalidated" }),
    }),
    /reviewId/
  );
  await assert.rejects(
    teardownCloudflarePreview(result.state, {
      allowLive: true,
      api,
      acceptanceUrl: "https://acceptance.example",
      token: "token",
      reviewId: "review-id",
      fetchImpl: async () => jsonResponse({ success: true, reviewId: "review-id", manifestHash: "b".repeat(64), state: "invalidated" }),
    }),
    /manifestHash/
  );
  const wrongCommitResponses = [
    { success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, state: "invalidated" },
    { success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, revision: "other", satisfied: false, state: "invalidated" },
  ];
  await assert.rejects(
    teardownCloudflarePreview(result.state, {
      allowLive: true,
      api,
      acceptanceUrl: "https://acceptance.example",
      token: "token",
      reviewId: "review-id",
      fetchImpl: async () => jsonResponse(wrongCommitResponses.shift()),
    }),
    /commit/
  );
  const tampered = structuredClone(result.state);
  tampered.components[0].name = "nib";
  await assert.rejects(
    teardownCloudflarePreview(tampered, {
      allowLive: true,
      api,
      acceptanceUrl: "https://acceptance.example",
      token: "token",
      reviewId: "review-id",
      fetchImpl: async () => jsonResponse({ success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, state: "invalidated" }),
    }),
    /ownership digest/
  );
  const originalMaterializedPlan = await readFile(result.state.materialized.planPath, "utf8");
  await writeFile(result.state.materialized.planPath, JSON.stringify({ contract: "nib.cloudflare-preview/v1", stackSlug: "other", planSha256: result.state.planSha256 }));
  await assert.rejects(
    teardownCloudflarePreview(result.state, {
      allowLive: true,
      api,
      acceptanceUrl: "https://acceptance.example",
      token: "token",
      reviewId: "review-id",
      fetchImpl: async () => jsonResponse({ success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, state: "invalidated" }),
    }),
    /materialized plan/
  );
  await writeFile(result.state.materialized.planPath, originalMaterializedPlan);
  const originalJournal = await readFile(result.state.journalPath, "utf8");
  const tamperedJournal = JSON.parse(originalJournal);
  const tamperedMigration = tamperedJournal.operations.find((operation) => operation.action === "migrate" && operation.type === "d1");
  tamperedMigration.result.databaseId = "other-d1";
  await writeFile(result.state.journalPath, `${JSON.stringify(tamperedJournal, null, 2)}\n`);
  await assert.rejects(
    teardownCloudflarePreview(result.state, {
      allowLive: true,
      api,
      acceptanceUrl: "https://acceptance.example",
      token: "token",
      reviewId: "review-id",
      fetchImpl: async () => jsonResponse({ success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, state: "invalidated" }),
    }),
    /D1 migration proof/
  );
  await writeFile(result.state.journalPath, originalJournal);
  const responses = [
    { success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, state: "invalidated" },
    { success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, revision: "abc123", satisfied: false, state: "invalidated" },
  ];
  const teardown = await teardownCloudflarePreview(result.state, {
    allowLive: true,
    api,
    acceptanceUrl: "https://acceptance.example",
    token: "token",
    reviewId: "review-id",
    fetchImpl: async () => jsonResponse(responses.shift()),
  });
  assert.equal(teardown.tornDown, true);
  assert.equal(api.calls.some((call) => call[0] === "deleteR2Object"), false);
});

test("teardown retry skips owned 404 deletes without Cloudflare version probes", async () => {
  const root = await fixtureRoot();
  await writeFile(path.join(root, "fixtures", "object.json"), JSON.stringify({ ok: true }));
  const recipe = recipeFor(root);
  recipe.cloudflare.components[0].seed.r2 = [{
    binding: "ARTIFACTS",
    key: "object.json",
    file: path.relative(root, path.join(root, "fixtures", "object.json")),
  }];
  const result = await deployCloudflarePreview(recipe, { root, dryRun: false, allowLive: true, api: new FakeCloudflareApi() });
  const deleted404 = new Set([
    `worker:${result.state.components[0].name}`,
    `r2:${result.state.r2Objects[0].bucket}/${result.state.r2Objects[0].key}`,
    `resource:${result.state.resources[0].type}:${result.state.resources[0].name}`,
  ]);
  class PartialRetryApi extends FakeCloudflareApi {
    async getLatestDeployment() {
      throw new Error("teardown must not probe Cloudflare deployments");
    }

    async getWorkerVersion() {
      throw new Error("teardown must not probe Cloudflare versions");
    }

    async getWorkerPreviewUrl() {
      throw new Error("teardown must not probe Cloudflare preview URL");
    }

    async deleteWorker(workerName) {
      this.calls.push(["deleteWorker", workerName]);
      if (deleted404.has(`worker:${workerName}`)) throw notFound();
      this.workers.delete(workerName);
    }

    async deleteR2Object(bucket, key) {
      this.calls.push(["deleteR2Object", bucket, key]);
      if (deleted404.has(`r2:${bucket}/${key}`)) throw notFound();
    }

    async deleteResource(type, name) {
      this.calls.push(["deleteResource", type, name]);
      if (deleted404.has(`resource:${type}:${name}`)) throw notFound();
      this.resources.delete(`${type}:${name}`);
    }
  }
  const retryApi = new PartialRetryApi({
    workers: result.state.components.map((component) => component.name),
    resources: result.state.resources,
  });
  const requests = [];
  const responses = [
    { success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, state: "invalidated" },
    { success: true, reviewId: "review-id", manifestHash: result.state.manifestHash, revision: "abc123", satisfied: false, state: "invalidated" },
  ];
  const teardown = await teardownCloudflarePreview(result.state, {
    allowLive: true,
    api: retryApi,
    acceptanceUrl: "https://acceptance.example",
    token: "token",
    reviewId: "review-id",
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return jsonResponse(responses.shift());
    },
  });
  assert.equal(teardown.tornDown, true);
  assert.equal(requests.length, 2);
  assert.equal("deploymentVerification" in requests[1].body, false);
  assert.equal(requests[1].body.commit, "abc123");
  assert.equal(retryApi.calls.some((call) => call[0] === "deleteWorker"), true);
  assert.equal(retryApi.calls.some((call) => call[0] === "deleteR2Object"), true);
  assert.equal(retryApi.calls.some((call) => call[0] === "deleteResource"), true);
});

test("journal resumes an exact plan after partial resource creation", async () => {
  const root = await fixtureRoot();
  const stateDir = path.join(root, ".state");
  class FailingDeployApi extends FakeCloudflareApi {
    async deployWorker(component) {
      this.calls.push(["deployWorker", component.name]);
      throw new Error("deploy failed");
    }
  }
  await assert.rejects(
    deployCloudflarePreview(recipeFor(root), { root, stateDir, dryRun: false, allowLive: true, api: new FailingDeployApi() }),
    /deploy failed/
  );
  const plan = await planCloudflarePreview(recipeFor(root), { root, stateDir });
  const created = plan.operations.filter((operation) => operation.action === "create").map((operation) => ({
    type: operation.type,
    name: operation.name,
    id: `${operation.type}-already-created`,
  }));
  const retryApi = new FakeCloudflareApi({ resources: created });
  const result = await deployCloudflarePreview(recipeFor(root), { root, stateDir, dryRun: false, allowLive: true, api: retryApi });
  assert.equal(result.verification.satisfied, true);
  assert.equal(retryApi.calls.some((call) => call[0] === "resourceExists" && created.some((resource) => resource.name === call[2])), false);
  assert.equal(retryApi.calls.some((call) => call[0] === "applyD1Migrations"), false);
  assert.equal(retryApi.calls.some((call) => call[0] === "seedResource"), false);
});

function notFound() {
  const error = new Error("404 not found");
  error.status = 404;
  return error;
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "nib-cf-preview-"));
  await mkdir(path.join(root, "workers", "app", "migrations"), { recursive: true });
  await mkdir(path.join(root, "workers", "review"), { recursive: true });
  await mkdir(path.join(root, "fixtures"), { recursive: true });
  await writeFile(path.join(root, "workers", "app", "index.ts"), "export default { fetch() { return new Response('ok') } };\n");
  await writeFile(path.join(root, "workers", "review", "index.ts"), "export default { fetch() { return new Response('review') } };\n");
  await writeFile(path.join(root, "workers", "app", "migrations", "0001.sql"), "create table account(id text primary key);\n");
  await writeFile(path.join(root, "fixtures", "seed.sql"), "insert into account(id) values ('pilot');\n");
  await writeFile(path.join(root, "workers", "app", "wrangler.jsonc"), JSON.stringify({
    name: "app-worker",
    main: "index.ts",
    compatibility_date: "2026-08-02",
    vars: { ENVIRONMENT: "production" },
    preview_urls: true,
    routes: [{ pattern: "example.com", custom_domain: true }],
    send_email: [{ name: "EMAIL", allowed_sender_addresses: ["login@example.com"] }],
    services: [{ binding: "REVIEW", service: "review-worker" }],
    d1_databases: [{ binding: "DB", database_name: "prod-db", database_id: "prod", migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "prod-artifacts" }],
    queues: { producers: [{ binding: "EVENTS", queue: "prod-events" }] },
    durable_objects: { bindings: [{ name: "GATE", class_name: "Gate" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Gate"] }],
  }, null, 2));
  await writeFile(path.join(root, "workers", "review", "wrangler.jsonc"), JSON.stringify({
    name: "review-worker",
    main: "index.ts",
    compatibility_date: "2026-08-02",
    preview_urls: true,
  }, null, 2));
  return root;
}

function recipeFor(root) {
  return {
    contract: "nib.cloudflare-preview/v1",
    projectId: "project-alpha",
    subject: "onboarding",
    gate: "acceptance",
    title: "Pilot onboarding acceptance",
    request: "Review the onboarding preview.",
    change: "Adds the isolated Cloudflare preview adapter.",
    revision: "abc123",
    build: { commit: "abc123" },
    criteria: [{ id: "c1", text: "Preview uses isolated resources." }],
    cloudflare: {
      components: [
        {
          name: "app-worker",
          primary: true,
          preview: "isolated-stack",
          config: path.relative(root, path.join(root, "workers", "app", "wrangler.jsonc")),
          cwd: path.relative(root, path.join(root, "workers", "app")),
          seed: { d1: [{ binding: "DB", file: path.relative(root, path.join(root, "fixtures", "seed.sql")) }] },
        },
        {
          name: "review-worker",
          config: path.relative(root, path.join(root, "workers", "review", "wrangler.jsonc")),
          cwd: path.relative(root, path.join(root, "workers", "review")),
        },
      ],
    },
  };
}
