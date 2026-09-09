import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const PREVIEW_CONTRACT = "nib.cloudflare-preview/v1";
export const ACCEPTANCE_CONTRACT = "nib.acceptance/v1";

const DEFAULT_STATE_DIR = ".nib/cloudflare-previews";
const RESOURCE_TYPES = ["d1", "r2", "queue"];

export async function loadPreviewRecipe(recipePath, options = {}) {
  const root = options.root ?? process.cwd();
  const absolutePath = path.resolve(root, recipePath);
  const source = await readFile(absolutePath, "utf8");
  const recipe = parseJsonc(source);
  if (recipe.contract !== PREVIEW_CONTRACT) {
    throw new Error(`Unsupported Cloudflare preview contract: ${recipe.contract ?? "(missing)"}`);
  }
  return recipe;
}

export async function planCloudflarePreview(recipe, options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const revision = normalizeRevision(recipe.revision ?? recipe.build?.commit);
  const projectId = requireString(recipe.projectId, "projectId");
  const subject = requireString(recipe.subject, "subject");
  const gate = requireString(recipe.gate, "gate");
  const stackSlug = buildStackSlug(recipe, revision);
  const stateDir = path.resolve(root, options.stateDir ?? recipe.cloudflare?.stateDir ?? DEFAULT_STATE_DIR, stackSlug);
  const accountIdEnv = recipe.cloudflare?.accountIdEnv ?? "CLOUDFLARE_ACCOUNT_ID";
  const apiTokenEnv = recipe.cloudflare?.apiTokenEnv ?? "CLOUDFLARE_API_TOKEN";
  const wranglerPackage = recipe.cloudflare?.wranglerPackage ?? "apps/web";
  const components = await loadComponents(recipe, root, stackSlug);
  const primary = components.find((component) => component.primary) ?? components[0];
  if (!primary) {
    throw new Error("Cloudflare preview recipe must define at least one component");
  }

  const componentByBaseName = new Map();
  for (const component of components) {
    componentByBaseName.set(component.baseName, component);
  }

  const plannedComponents = components.map((component) =>
    planComponent(component, componentByBaseName, stackSlug, stateDir, primary.previewName)
  );
  const resourceOperations = plannedComponents.flatMap((component) => component.resourceOperations);
  const componentOperations = plannedComponents.flatMap((component) => component.operations);
  const configDigests = Object.fromEntries(
    plannedComponents.map((component) => [component.name, component.configSha256])
  );
  const assetsDigests = Object.fromEntries(
    plannedComponents
      .filter((component) => component.assetsSha256)
      .map((component) => [component.name, component.assetsSha256])
  );

  const plan = {
    contract: PREVIEW_CONTRACT,
    dryRun: true,
    root,
    stateDir,
    projectId,
    subject,
    gate,
    revision,
    stackSlug,
    accountIdEnv,
    apiTokenEnv,
    wranglerPackage,
    previewKind: "isolated-stack",
    primaryComponent: primary.previewName,
    components: plannedComponents,
    operations: [...resourceOperations, ...componentOperations],
    manifestDraft: buildManifestDraft(recipe, plannedComponents, {
      primaryPreviewUrl: previewUrlTemplate(primary.previewName, stackSlug),
      configSha256: sha256Hex(stableJson(configDigests)),
      assetsSha256: sha256Hex(stableJson(assetsDigests)),
    }),
  };
  plan.planSha256 = sha256Hex(stableJson(stripGeneratedConfig(plan)));
  return plan;
}

export async function materializePlan(plan) {
  for (const component of plan.components) {
    await mkdir(path.dirname(component.generatedConfigPath), { recursive: true });
    await writeFile(component.generatedConfigPath, `${JSON.stringify(component.generatedConfig, null, 2)}\n`);
  }
  await mkdir(plan.stateDir, { recursive: true });
  const planPath = path.join(plan.stateDir, "plan.json");
  await writeFile(planPath, `${JSON.stringify(stripGeneratedConfig(plan), null, 2)}\n`);
  return { planPath, configPaths: plan.components.map((component) => component.generatedConfigPath) };
}

export async function deployCloudflarePreview(recipe, options = {}) {
  const dryRun = options.dryRun ?? true;
  const plan = await planCloudflarePreview(recipe, options);
  if (dryRun) {
    return { dryRun: true, plan };
  }
  if (!options.allowLive) {
    throw new Error("Live Cloudflare preview deployment requires allowLive: true");
  }
  assertNoMissingAssets(plan);
  const api = options.api ?? new LiveCloudflareApi({
    accountId: process.env[plan.accountIdEnv],
    apiToken: process.env[plan.apiTokenEnv],
    runner: options.runner,
    wranglerPackage: path.resolve(plan.root, plan.wranglerPackage),
  });
  const journal = await loadJournal(plan);
  await assertNoSilentOverwrite(api, plan, journal);
  await applyActualPreviewOrigins(api, plan);
  const createdResources = await applyCreateOperations(api, plan, journal);
  applyCreatedResourceIds(plan, createdResources);
  refreshComponentDigests(plan);
  const materialized = await materializePlan(plan);
  await applyDataOperations(api, plan, journal, createdResources);
  const deployedComponents = await applyWorkerOperations(api, plan, journal);
  const manifest = finalizeAcceptanceManifest(recipe, plan, deployedComponents);
  const localState = buildLocalState(plan, manifest, deployedComponents, createdResources, journal, materialized);
  const verification = await verifyCloudflareManifest(api, manifest, localState);
  if (!verification.satisfied) {
    throw new Error(`Cloudflare preview verification failed: ${verification.reason}`);
  }
  await writeFile(path.join(plan.stateDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(plan.stateDir, "state.json"), `${JSON.stringify(localState, null, 2)}\n`);
  return { dryRun: false, plan, manifest, verification, materialized, state: localState };
}

export async function verifyCloudflareManifest(api, manifest, localState) {
  const expectedComponents = manifest.build?.deployment?.components ?? [];
  if (expectedComponents.length === 0) {
    return { satisfied: false, reason: "manifest has no Cloudflare deployment components" };
  }
  if (!localState || localState.contract !== PREVIEW_CONTRACT || !localState.ownershipSha256) {
    return { satisfied: false, reason: "Cloudflare preview ownership state is required" };
  }
  if (localState.ownershipSha256 !== ownershipDigest(localState)) {
    return { satisfied: false, reason: "Cloudflare preview ownership state digest does not match its contents" };
  }
  if (localState.manifestHash !== sha256Hex(stableJson(manifest))) {
    return { satisfied: false, reason: "manifest hash does not match Cloudflare preview ownership state" };
  }
  const ownedComponents = new Map((localState.components ?? []).map((component) => [component.name, component]));
  for (const component of expectedComponents) {
    const owned = ownedComponents.get(component.name);
    if (!owned || owned.versionId !== component.versionId || owned.stackSlug !== localState.stackSlug) {
      return {
        satisfied: false,
        reason: `${component.name} is not owned by preview stack ${localState.stackSlug}`,
      };
    }
    const deployment = await api.getLatestDeployment(component.name);
    const active = deployment?.versions ?? [];
    const matching = active.find((version) => version.version_id === component.versionId);
    if (!matching) {
      return {
        satisfied: false,
        reason: `${component.name} is not serving expected version ${component.versionId}`,
      };
    }
    if (Number(matching.percentage) !== 100) {
      return {
        satisfied: false,
        reason: `${component.name} version ${component.versionId} is only serving ${matching.percentage}%`,
      };
    }
    const version = await api.getWorkerVersion(component.name, component.versionId);
    if (!version?.id || version.id !== component.versionId) {
      return {
        satisfied: false,
        reason: `${component.name} version detail did not confirm ${component.versionId}`,
      };
    }
    if (component.name === localState.primaryComponent) {
      const previewUrl = await api.getWorkerPreviewUrl(component.name);
      if (previewUrl !== manifest.build.previewUrl) {
        return {
          satisfied: false,
          reason: `${component.name} preview URL ${manifest.build.previewUrl} does not match owned Worker URL ${previewUrl}`,
        };
      }
    }
  }
  return { satisfied: true, reason: "all Cloudflare component versions are active and exact" };
}

export async function publishAcceptanceManifest({ acceptanceUrl, token, manifest, idempotencyKey, fetchImpl = fetch }) {
  const projectId = encodeURIComponent(manifest.projectId);
  const response = await fetchImpl(`${acceptanceUrl.replace(/\/$/, "")}/api/acceptance/v1/projects/${projectId}/reviews`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey ?? manifest.build.deployment.id,
    },
    body: JSON.stringify({ manifest }),
  });
  return readJsonResponse(response);
}

export async function verifyAcceptanceGateFromManifest({
  acceptanceUrl,
  token,
  manifest,
  reviewId,
  api,
  localState,
  state,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  const ownedState = localState ?? state;
  if (!api || !ownedState) {
    throw new Error("Cloudflare acceptance verification requires api and owned local preview state");
  }
  const cloudflareVerification = await verifyCloudflareManifest(api, manifest, ownedState);
  if (!cloudflareVerification.satisfied) {
    throw new Error(`Cloudflare acceptance verification failed: ${cloudflareVerification.reason}`);
  }
  const manifestHash = sha256Hex(stableJson(manifest));
  const deploymentVerification = {
    manifestHash,
    commit: manifest.build.commit,
    verifiedAt: now().toISOString(),
  };
  const idempotencyKey = `${manifest.build.deployment.id}:verify:${sha256Hex(stableJson(deploymentVerification))}`;
  const projectId = encodeURIComponent(manifest.projectId);
  const response = await fetchImpl(
    `${acceptanceUrl.replace(/\/$/, "")}/api/acceptance/v1/projects/${projectId}/reviews/${encodeURIComponent(reviewId)}/verify`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        manifestHash,
        commit: manifest.build.commit,
        subject: manifest.subject,
        gate: manifest.gate,
        deploymentVerification,
      }),
    }
  );
  return readJsonResponse(response);
}

async function verifyInvalidatedAcceptanceReview({
  acceptanceUrl,
  token,
  manifest,
  reviewId,
  fetchImpl = fetch,
}) {
  const manifestHash = sha256Hex(stableJson(manifest));
  const projectId = encodeURIComponent(manifest.projectId);
  const response = await fetchImpl(
    `${acceptanceUrl.replace(/\/$/, "")}/api/acceptance/v1/projects/${projectId}/reviews/${encodeURIComponent(reviewId)}/verify`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `${manifest.build.deployment.id}:verify-invalidated:${reviewId}`,
      },
      body: JSON.stringify({
        manifestHash,
        commit: manifest.build.commit,
        subject: manifest.subject,
        gate: manifest.gate,
      }),
    }
  );
  return readJsonResponse(response);
}

export async function invalidateAcceptanceReview({
  acceptanceUrl,
  token,
  projectId,
  reviewId,
  reason,
  idempotencyKey,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `${acceptanceUrl.replace(/\/$/, "")}/api/acceptance/v1/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/invalidate`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey ?? `${reviewId}:invalidate`,
      },
      body: JSON.stringify({ reason }),
    }
  );
  return readJsonResponse(response);
}

export async function teardownCloudflarePreview(state, options = {}) {
  if (!options.allowLive) {
    throw new Error("Live Cloudflare preview teardown requires allowLive: true");
  }
  if (!state || state.contract !== PREVIEW_CONTRACT || !state.ownershipSha256) {
    throw new Error("Cloudflare preview teardown requires an owned local preview state file");
  }
  const manifest = state.manifest;
  if (!manifest) {
    throw new Error("Cloudflare preview teardown state is missing its manifest");
  }
  await validateOwnedStateForTeardown(state);
  if (!options.acceptanceUrl || !options.token || !options.reviewId) {
    throw new Error("Cloudflare preview teardown requires authenticated acceptance invalidation before deletion");
  }
  const api = options.api ?? new LiveCloudflareApi({
    accountId: process.env[options.accountIdEnv ?? "CLOUDFLARE_ACCOUNT_ID"],
    apiToken: process.env[options.apiTokenEnv ?? "CLOUDFLARE_API_TOKEN"],
    runner: options.runner,
    wranglerPackage: path.resolve(options.root ?? process.cwd(), options.wranglerPackage ?? "apps/web"),
  });
  const invalidation = await invalidateAcceptanceReview({
    acceptanceUrl: options.acceptanceUrl,
    token: options.token,
    projectId: manifest.projectId,
    reviewId: options.reviewId,
    reason: options.reason ?? "Cloudflare preview teardown",
    fetchImpl: options.fetchImpl,
  });
  assertAcceptanceResponseMatchesState(invalidation, state, options.reviewId, "invalidation");
  if (invalidation.state !== "invalidated") {
    throw new Error("Acceptance invalidation did not return invalidated state");
  }
  const acceptance = await verifyInvalidatedAcceptanceReview({
    acceptanceUrl: options.acceptanceUrl,
    token: options.token,
    manifest,
    reviewId: options.reviewId,
    fetchImpl: options.fetchImpl,
  });
  assertAcceptanceResponseMatchesState(acceptance, state, options.reviewId, "verify", { requireCommit: true });
  if (acceptance.satisfied !== false || acceptance.state !== "invalidated") {
    throw new Error("Acceptance review is still active; refusing to delete Cloudflare preview stack");
  }
  assertOwnedNames(state);
  for (const component of [...state.components].reverse()) {
    await ignoreNotFoundForOwnedDelete(() => api.deleteWorker(component.name));
  }
  for (const resource of [...state.r2Objects ?? []].reverse()) {
    await ignoreNotFoundForOwnedDelete(() => api.deleteR2Object(resource.bucket, resource.key));
  }
  for (const resource of [...state.resources].reverse()) {
    await ignoreNotFoundForOwnedDelete(() => api.deleteResource(resource.type, resource.name));
  }
  return { tornDown: true, components: state.components.length, resources: state.resources.length };
}

function assertAcceptanceResponseMatchesState(response, state, reviewId, label, options = {}) {
  if (response.reviewId !== reviewId) {
    throw new Error(`Acceptance ${label} response reviewId ${response.reviewId} does not match ${reviewId}`);
  }
  if (response.manifestHash !== state.manifestHash) {
    throw new Error(`Acceptance ${label} response manifestHash does not match owned preview state`);
  }
  if (options.requireCommit) {
    const responseCommit = response.commit ?? response.revision;
    if (responseCommit !== state.manifest.build.commit) {
      throw new Error(`Acceptance ${label} response commit ${responseCommit} does not match owned preview state`);
    }
  }
}

async function ignoreNotFoundForOwnedDelete(deleteOperation) {
  try {
    await deleteOperation();
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

function isNotFoundError(error) {
  return (
    error?.status === 404 ||
    error?.statusCode === 404 ||
    error?.code === 404 ||
    /\b404\b|not found/i.test(String(error?.message ?? error))
  );
}

export function finalizeAcceptanceManifest(recipe, plan, deployedComponents) {
  const primary = deployedComponents.find((component) => component.name === plan.primaryComponent) ?? deployedComponents[0];
  if (!primary) {
    throw new Error("Cannot finalize manifest without deployed component versions");
  }
  return buildManifestDraft(recipe, plan.components, {
    deploymentId: `${plan.stackSlug}:${primary.deploymentId ?? primary.versionId}`,
    primaryPreviewUrl: primary.previewUrl,
    deployedComponents,
    configSha256: plan.manifestDraft.build.deployment.configSha256,
    assetsSha256: plan.manifestDraft.build.deployment.assetsSha256,
  });
}

export class FakeCloudflareApi {
  constructor(seed = {}) {
    this.calls = [];
    this.resources = new Map(seed.resources?.map((resource) => [resourceKey(resource.type, resource.name), resource]) ?? []);
    this.versions = new Map(seed.versions?.map((version) => [`${version.workerName}:${version.id}`, version]) ?? []);
    this.deployments = new Map(seed.deployments?.map((deployment) => [deployment.workerName, deployment]) ?? []);
    this.workers = new Set(seed.workers ?? seed.deployments?.map((deployment) => deployment.workerName) ?? []);
  }

  async workerExists(workerName) {
    this.calls.push(["workerExists", workerName]);
    return this.workers.has(workerName);
  }

  async resourceExists(type, name) {
    this.calls.push(["resourceExists", type, name]);
    return this.resources.has(resourceKey(type, name));
  }

  async createResource(type, name, details = {}) {
    this.calls.push(["createResource", type, name]);
    const key = resourceKey(type, name);
    if (this.resources.has(key)) {
      throw new Error(`${type} resource already exists: ${name}`);
    }
    const resource = { type, name, id: `${type}-${sha256Hex(name).slice(0, 12)}`, ...details };
    this.resources.set(key, resource);
    return resource;
  }

  async applyD1Migrations(name, migration) {
    this.calls.push(["applyD1Migrations", name, migration.migrationsDir, migration.migrationsSha256]);
    return { type: "d1", name, migration };
  }

  async seedResource(type, name, seed) {
    this.calls.push(["seedResource", type, name, seed.file ?? seed.key ?? "(inline)"]);
    return { type, name, seed };
  }

  async deployWorker(component) {
    this.calls.push(["deployWorker", component.name]);
    const versionId = `${component.name}-${sha256Hex(component.configSha256).slice(0, 12)}`;
    const deploymentId = `${component.name}-deployment-${sha256Hex(versionId).slice(0, 8)}`;
    const version = {
      workerName: component.name,
      id: versionId,
      previewUrl: previewUrlTemplate(component.name, component.stackSlug),
      metadata: { hasPreview: true },
    };
    const deployment = {
      workerName: component.name,
      id: deploymentId,
      annotations: { "workers/message": component.message },
      versions: [{ version_id: versionId, percentage: 100 }],
    };
    this.workers.add(component.name);
    this.versions.set(`${component.name}:${versionId}`, version);
    this.deployments.set(component.name, deployment);
    return {
      name: component.name,
      versionId,
      deploymentId,
      previewUrl: component.generatedConfig?.workers_dev === false ? undefined : await this.getWorkerPreviewUrl(component.name),
    };
  }

  async getLatestDeployment(workerName) {
    this.calls.push(["getLatestDeployment", workerName]);
    return this.deployments.get(workerName) ?? null;
  }

  async getWorkerVersion(workerName, versionId) {
    this.calls.push(["getWorkerVersion", workerName, versionId]);
    return this.versions.get(`${workerName}:${versionId}`) ?? null;
  }

  async getWorkerPreviewUrl(workerName) {
    this.calls.push(["getWorkerPreviewUrl", workerName]);
    return `https://${workerName}.fake-subdomain.workers.dev`;
  }

  async deleteWorker(workerName) {
    this.calls.push(["deleteWorker", workerName]);
    this.deployments.delete(workerName);
    this.workers.delete(workerName);
  }

  async deleteResource(type, name) {
    this.calls.push(["deleteResource", type, name]);
    this.resources.delete(resourceKey(type, name));
  }

  async deleteR2Object(bucket, key) {
    this.calls.push(["deleteR2Object", bucket, key]);
  }
}

export class LiveCloudflareApi {
  constructor({ accountId, apiToken, runner, wranglerPackage, fetchImpl = fetch }) {
    if (!accountId) throw new Error("Cloudflare account id is required");
    if (!apiToken) throw new Error("Cloudflare API token is required");
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.runner = runner ?? new WranglerRunner(wranglerPackage);
    this.fetchImpl = fetchImpl;
  }

  async resourceExists(type, name) {
    if (!RESOURCE_TYPES.includes(type)) throw new Error(`Unsupported resource type: ${type}`);
    const result = await this.request(`/accounts/${this.accountId}/${resourceApiPath(type)}`);
    const items = Array.isArray(result.result) ? result.result : result.result?.items ?? result.result?.queues ?? result.result?.buckets ?? [];
    return items.some((item) => item.name === name || item.bucket_name === name);
  }

  async workerExists(workerName) {
    const response = await this.request(
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
      { allowNotFound: true }
    );
    return Boolean(response?.success);
  }

  async createResource(type, name, details = {}) {
    if (type === "d1") {
      const response = await this.request(`/accounts/${this.accountId}/d1/database`, {
        method: "POST",
        body: JSON.stringify({
          name,
          jurisdiction: details.jurisdiction,
          primary_location_hint: details.location,
        }),
      });
      const id = response.result?.uuid;
      if (!id) throw new Error(`Cloudflare D1 create did not return uuid for ${name}`);
      return { type, name, id };
    }
    if (type === "r2") {
      await this.runner.run(["r2", "bucket", "create", name]);
      return { type, name };
    }
    if (type === "queue") {
      await this.runner.run(["queues", "create", name]);
      return { type, name };
    }
    throw new Error(`Unsupported resource type: ${type}`);
  }

  async applyD1Migrations(name, migration) {
    await this.runner.run(["d1", "migrations", "apply", name, "--remote", "--config", migration.generatedConfigPath]);
    return { type: "d1", name, migrationsDir: migration.migrationsDir, migrationsSha256: migration.migrationsSha256 };
  }

  async seedResource(type, name, seed) {
    if (type === "d1") {
      await this.runner.run(["d1", "execute", name, "--remote", "--file", seed.file, "--config", seed.generatedConfigPath, "-y"]);
      return { type, name, seed };
    }
    if (type === "r2") {
      await this.runner.run(["r2", "object", "put", `${name}/${seed.key}`, "--file", seed.file, "--remote"]);
      return { type, name, seed };
    }
    if (type === "queue") {
      return { type, name, seed, skipped: "queue fixtures are documented only" };
    }
    throw new Error(`Unsupported resource type: ${type}`);
  }

  async deployWorker(component) {
    await this.runner.run([
      "deploy",
      "--config",
      component.generatedConfigPath,
      "--name",
      component.name,
      "--tag",
      component.versionTag,
      "--message",
      component.message,
    ]);
    const deployment = await this.getLatestDeployment(component.name);
    if (!deploymentMatchesMessage(deployment, component.message)) {
      throw new Error(`Latest deployment for ${component.name} did not come from this preview command; concurrent deploy detected`);
    }
    const active = deployment?.versions ?? [];
    const exact = active.find((version) => Number(version.percentage) === 100);
    if (!deployment?.id || !exact?.version_id) {
      throw new Error(`Cloudflare deploy did not produce an exact active version for ${component.name}`);
    }
    return {
      name: component.name,
      versionId: exact.version_id,
      deploymentId: deployment.id,
      previewUrl: component.generatedConfig?.workers_dev === false ? undefined : await this.getWorkerPreviewUrl(component.name),
    };
  }

  async getLatestDeployment(workerName) {
    const response = await this.request(`/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(workerName)}/deployments`);
    const deployments = response.result?.deployments ?? response.result ?? [];
    return deployments[0] ?? null;
  }

  async getWorkerVersion(workerName, versionId) {
    const response = await this.request(`/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(versionId)}`);
    return response.result ?? null;
  }

  async getWorkerPreviewUrl(workerName) {
    const response = await this.request(`/accounts/${this.accountId}/workers/subdomain`);
    const subdomain = response.result?.subdomain;
    if (!subdomain) throw new Error("Cloudflare account has no Workers subdomain for preview URL");
    return `https://${workerName}.${subdomain}.workers.dev`;
  }

  async deleteWorker(workerName) {
    await this.runner.run(["delete", workerName, "--force"]);
  }

  async deleteR2Object(bucket, key) {
    await this.runner.run(["r2", "object", "delete", `${bucket}/${key}`, "--remote", "-y"]);
  }

  async deleteResource(type, name) {
    if (type === "d1") return this.runner.run(["d1", "delete", name, "-y"]);
    if (type === "r2") return this.runner.run(["r2", "bucket", "delete", name]);
    if (type === "queue") return this.runner.run(["queues", "delete", name]);
    throw new Error(`Unsupported resource type: ${type}`);
  }

  async request(apiPath, init = {}) {
    const { allowNotFound, ...requestInit } = init;
    const response = await this.fetchImpl(`https://api.cloudflare.com/client/v4${apiPath}`, {
      ...requestInit,
      headers: {
        "Authorization": `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        ...requestInit.headers,
      },
    });
    if (allowNotFound && response.status === 404) return null;
    return readJsonResponse(response);
  }
}

export class WranglerRunner {
  constructor(packageRoot) {
    this.packageRoot = packageRoot;
  }

  async run(args) {
    const result = spawnSync("npx", ["wrangler", ...args], {
      cwd: this.packageRoot,
      encoding: "utf8",
      env: process.env,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0) {
      throw new Error(`wrangler ${args.join(" ")} failed with exit ${result.status}\n${output}`);
    }
    return output;
  }
}

async function loadComponents(recipe, root, stackSlug) {
  const components = recipe.cloudflare?.components ?? [];
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error("cloudflare.components must contain at least one component");
  }
  return Promise.all(components.map(async (component, index) => {
    const configPath = path.resolve(root, requireString(component.config, `cloudflare.components[${index}].config`));
    const config = parseJsonc(await readFile(configPath, "utf8"));
    if (component.vars) config.vars = { ...(config.vars ?? {}), ...component.vars };
    const cwd = path.resolve(root, component.cwd ?? path.dirname(component.config));
    const baseName = component.name ?? config.name;
    const assetState = await hashComponentAssets(root, config, component, configPath);
    const d1Migrations = await collectD1Migrations(config, cwd);
    if (!baseName) {
      throw new Error(`cloudflare.components[${index}] must define a name or config.name`);
    }
    return {
      ...component,
      baseName,
      baseConfig: config,
      configPath,
      cwd,
      seed: normalizeSeed(root, component.seed),
      primary: component.primary === true || (index === 0 && components.every((entry) => entry.primary !== true)),
      isolated: component.preview === "isolated-stack" || hasStatefulBindings(config),
      previewName: component.previewName ?? buildName(baseName, stackSlug),
      stackSlug,
      assetsSha256: assetState.sha256,
      missingAssets: assetState.missing,
      d1Migrations,
    };
  }));
}

async function collectD1Migrations(config, cwd) {
  const entries = {};
  for (const database of config.d1_databases ?? []) {
    if (!database.migrations_dir) continue;
    const dir = path.resolve(cwd, database.migrations_dir);
    entries[database.binding] = await hashDirectory(dir);
  }
  return entries;
}

async function hashDirectory(dir) {
  const files = await listFilesRecursive(dir);
  const records = [];
  for (const file of files) {
    const bytes = await readFile(file);
    records.push({
      path: path.relative(dir, file),
      sha256: sha256Hex(bytes),
    });
  }
  return {
    dir,
    files: records,
    sha256: sha256Hex(stableJson(records)),
  };
}

async function listFilesRecursive(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function normalizeSeed(root, seed) {
  if (!seed) return undefined;
  return {
    d1: (seed.d1 ?? []).map((entry) => ({ ...entry, file: path.resolve(root, entry.file) })),
    r2: (seed.r2 ?? []).map((entry) => ({ ...entry, file: path.resolve(root, entry.file) })),
  };
}

function planComponent(component, componentByBaseName, stackSlug, stateDir, primaryPreviewName) {
  const generatedConfigPath = path.join(stateDir, "configs", `${component.previewName}.wrangler.jsonc`);
  const generatedConfig = rewriteConfig(component, componentByBaseName, stackSlug, primaryPreviewName, path.dirname(generatedConfigPath));
  const configSha256 = sha256Hex(stableJson(generatedConfig));
  const resourceOperations = planResourceOperations(component, generatedConfig, stackSlug, generatedConfigPath);
  const versionTag = `acceptance-${stackSlug}`;
  const previewAlias = `accept-${stackSlug}`;
  const message = `Nib acceptance preview ${stackSlug}`;
  return {
    baseName: component.baseName,
    name: component.previewName,
    stackSlug,
    role: component.primary ? "primary" : "dependency",
    kind: component.isolated ? "worker-isolated-stack" : "worker-version-preview",
    isolated: component.isolated,
    sourceConfigPath: component.configPath,
    generatedConfigPath,
    generatedConfig,
    configSha256,
    assetsSha256: component.assetsSha256,
    missingAssets: component.missingAssets,
    versionTag,
    previewAlias,
    message,
    resourceOperations,
    operations: [
      {
        action: "wrangler deploy",
        component: component.previewName,
        argv: [
          "wrangler",
          "deploy",
          "--config",
          generatedConfigPath,
          "--name",
          component.previewName,
          "--tag",
          versionTag,
          "--message",
          message,
        ],
      },
    ],
  };
}

function rewriteConfig(component, componentByBaseName, stackSlug, primaryPreviewName, generatedConfigDir) {
  const config = structuredClone(component.baseConfig);
  config.name = component.previewName;
  config.workers_dev = component.primary === true;
  config.preview_urls = false;
  delete config.routes;
  delete config.route;
  delete config.domains;
  delete config.triggers;
  delete config.send_email;
  const publicOrigin = previewUrlTemplate(primaryPreviewName, stackSlug);
  config.vars = {
    ...(config.vars ?? {}),
    ENVIRONMENT: config.vars?.ENVIRONMENT ?? "acceptance-preview",
    PUBLIC_ORIGIN: publicOrigin,
    NIB_ACCEPTANCE_ORIGIN: publicOrigin,
    ACCEPTANCE_PREVIEW_STACK: stackSlug,
  };

  if (Array.isArray(config.d1_databases)) {
    config.d1_databases = config.d1_databases.map((database) => {
      const migrationState = component.d1Migrations?.[database.binding];
      const migrationsDir = migrationState
        ? path.relative(generatedConfigDir, migrationState.dir) || "."
        : database.migrations_dir;
      return {
        ...database,
        migrations_dir: migrationsDir,
        database_name: buildResourceName(database.database_name ?? database.binding, stackSlug),
        database_id: `__created_by_nib_acceptance_${slug(database.binding ?? "db")}__`,
      };
    });
  }
  if (Array.isArray(config.r2_buckets)) {
    config.r2_buckets = config.r2_buckets.map((bucket) => ({
      ...bucket,
      bucket_name: buildResourceName(bucket.bucket_name ?? bucket.binding, stackSlug),
      preview_bucket_name: buildResourceName(bucket.preview_bucket_name ?? `${bucket.binding}-preview`, stackSlug),
    }));
  }
  if (config.queues) {
    config.queues = structuredClone(config.queues);
    if (Array.isArray(config.queues.producers)) {
      config.queues.producers = config.queues.producers.map((queue) => ({
        ...queue,
        queue: buildResourceName(queue.queue ?? queue.binding, stackSlug),
      }));
    }
    if (Array.isArray(config.queues.consumers)) {
      config.queues.consumers = config.queues.consumers.map((queue) => ({
        ...queue,
        queue: buildResourceName(queue.queue, stackSlug),
        dead_letter_queue: queue.dead_letter_queue ? buildResourceName(queue.dead_letter_queue, stackSlug) : undefined,
      }));
    }
  }
  if (Array.isArray(config.services)) {
    config.services = config.services.map((service) => {
      const target = componentByBaseName.get(service.service);
      if (!target) {
        throw new Error(
          `${component.baseName} service binding ${service.binding} targets ${service.service}; add that Worker as a preview component`
        );
      }
      return { ...service, service: target.previewName };
    });
  }
  assertNoProductionBindingNames(config, component.baseName);
  return config;
}

function planResourceOperations(component, config, stackSlug, generatedConfigPath) {
  const operations = [];
  for (const database of config.d1_databases ?? []) {
    operations.push({
      type: "d1",
      action: "create",
      component: component.previewName,
      binding: database.binding,
      name: database.database_name,
      idempotencyKey: `${stackSlug}:d1:${database.database_name}`,
    });
    const migrationState = component.d1Migrations?.[database.binding];
    if (migrationState) {
      operations.push({
        type: "d1",
        action: "migrate",
        component: component.previewName,
        binding: database.binding,
        name: database.database_name,
        generatedConfigPath,
        migrationsDir: migrationState.dir,
        migrationsSha256: migrationState.sha256,
        files: migrationState.files,
        idempotencyKey: `${stackSlug}:d1-migrate:${database.binding}:${migrationState.sha256}`,
      });
    }
  }
  for (const bucket of config.r2_buckets ?? []) {
    operations.push({
      type: "r2",
      action: "create",
      component: component.previewName,
      binding: bucket.binding,
      name: bucket.bucket_name,
      idempotencyKey: `${stackSlug}:r2:${bucket.bucket_name}`,
    });
  }
  for (const queue of config.queues?.producers ?? []) {
    operations.push({
      type: "queue",
      action: "create",
      component: component.previewName,
      binding: queue.binding,
      name: queue.queue,
      idempotencyKey: `${stackSlug}:queue:${queue.queue}`,
    });
  }
  for (const queue of config.queues?.consumers ?? []) {
    if (queue.dead_letter_queue) {
      operations.push({
        type: "queue",
        action: "create",
        component: component.previewName,
        binding: `${queue.queue}:dlq`,
        name: queue.dead_letter_queue,
        idempotencyKey: `${stackSlug}:queue:${queue.dead_letter_queue}`,
      });
    }
  }
  for (const seed of component.seed?.d1 ?? []) {
    operations.push({
      type: "d1",
      action: "seed",
      component: component.previewName,
      binding: seed.binding,
      name: findD1Name(config, seed.binding),
      generatedConfigPath,
      file: seed.file,
      sha256: seed.sha256,
      idempotencyKey: `${stackSlug}:d1-seed:${seed.binding}:${seed.file}`,
    });
  }
  for (const seed of component.seed?.r2 ?? []) {
    operations.push({
      type: "r2",
      action: "seed",
      component: component.previewName,
      binding: seed.binding,
      name: findR2Name(config, seed.binding),
      key: seed.key,
      file: seed.file,
      sha256: seed.sha256,
      idempotencyKey: `${stackSlug}:r2-seed:${seed.binding}:${seed.key}`,
    });
  }
  return dedupeOperations(operations);
}

async function assertNoSilentOverwrite(api, plan, journal) {
  for (const component of plan.components) {
    if (hasJournalEntry(journal, "deploy-worker", component.name)) continue;
    if (await api.workerExists(component.name)) {
      throw new Error(
        `Refusing to overwrite existing Cloudflare Worker ${component.name}; choose a new revision or teardown the prior stack`
      );
    }
  }
  for (const operation of plan.operations.filter((entry) => entry.action === "create")) {
    if (hasJournalEntry(journal, operation.idempotencyKey, operation.name)) continue;
    if (await api.resourceExists(operation.type, operation.name)) {
      throw new Error(
        `Refusing to overwrite existing Cloudflare ${operation.type} resource ${operation.name}; choose a new revision or teardown the prior stack`
      );
    }
  }
}

function assertNoMissingAssets(plan) {
  const missing = plan.components.flatMap((component) =>
    (component.missingAssets ?? []).map((assetPath) => `${component.name}: ${assetPath}`)
  );
  if (missing.length > 0) {
    throw new Error(`Live Cloudflare preview deployment requires built assets:\n${missing.join("\n")}`);
  }
}

async function applyCreateOperations(api, plan, journal) {
  const createdResources = [];
  for (const operation of plan.operations.filter((entry) => entry.action === "create")) {
    const prior = findJournalEntry(journal, operation.idempotencyKey, operation.name);
    if (prior?.result) {
      createdResources.push(prior.result);
      continue;
    }
    const result = await api.createResource(operation.type, operation.name, operation);
    await appendJournalEntry(plan, journal, {
      key: operation.idempotencyKey,
      target: operation.name,
      action: operation.action,
      type: operation.type,
      result,
    });
    createdResources.push(result);
  }
  return createdResources;
}

async function applyDataOperations(api, plan, journal, createdResources) {
  for (const operation of plan.operations.filter((entry) => entry.action === "migrate" || entry.action === "seed")) {
    if (operation.action === "migrate") {
      const prior = findJournalEntry(journal, operation.idempotencyKey, operation.name);
      if (prior?.result) continue;
      const owned = requireOwnedD1Resource(createdResources, operation);
      await api.applyD1Migrations(operation.name, operation);
      await appendJournalEntry(plan, journal, {
        key: operation.idempotencyKey,
        target: operation.name,
        action: operation.action,
        type: operation.type,
        result: {
          type: operation.type,
          name: operation.name,
          databaseId: owned.id,
          migrationsDir: operation.migrationsDir,
          migrationsSha256: operation.migrationsSha256,
        },
      });
      continue;
    }
    const prior = findJournalEntry(journal, operation.idempotencyKey, operation.name);
    if (prior?.result) continue;
    const owned = operation.type === "d1" ? requireOwnedD1Resource(createdResources, operation) : undefined;
    await api.seedResource(operation.type, operation.name, operation);
    await appendJournalEntry(plan, journal, {
      key: operation.idempotencyKey,
      target: operation.name,
      action: operation.action,
      type: operation.type,
      result: {
        type: operation.type,
        name: operation.name,
        databaseId: owned?.id,
        file: operation.file,
        key: operation.key,
      },
    });
  }
}

async function loadJournal(plan) {
  await mkdir(plan.stateDir, { recursive: true });
  const journalPath = path.join(plan.stateDir, "journal.json");
  try {
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    if (journal.contract !== PREVIEW_CONTRACT || journal.planSha256 !== plan.planSha256) {
      throw new Error(`Refusing to resume Cloudflare preview from incompatible journal at ${journalPath}`);
    }
    journal.path = journalPath;
    journal.operations ??= [];
    return journal;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const journal = {
      contract: PREVIEW_CONTRACT,
      stackSlug: plan.stackSlug,
      planSha256: plan.planSha256,
      createdAt: new Date().toISOString(),
      operations: [],
      path: journalPath,
    };
    await writeFile(journalPath, `${JSON.stringify({ ...journal, path: undefined }, null, 2)}\n`);
    return journal;
  }
}

function findJournalEntry(journal, key, target) {
  return journal?.operations?.find((entry) => entry.key === key && entry.target === target && entry.status === "succeeded");
}

function hasJournalEntry(journal, key, target) {
  return Boolean(findJournalEntry(journal, key, target));
}

async function appendJournalEntry(plan, journal, entry) {
  journal.operations.push({
    ...entry,
    status: "succeeded",
    completedAt: new Date().toISOString(),
  });
  await writeFile(journal.path, `${JSON.stringify({ ...journal, path: undefined }, null, 2)}\n`);
}

function requireOwnedD1Resource(createdResources, operation) {
  const owned = createdResources.find((resource) => resource.type === "d1" && resource.name === operation.name);
  if (!owned?.id) {
    throw new Error(`Cloudflare D1 ${operation.name} requires owned database id proof before ${operation.action}`);
  }
  return owned;
}

function applyCreatedResourceIds(plan, createdResources) {
  const byKey = new Map(createdResources.map((resource) => [resourceKey(resource.type, resource.name), resource]));
  for (const component of plan.components) {
    for (const database of component.generatedConfig.d1_databases ?? []) {
      const created = byKey.get(resourceKey("d1", database.database_name));
      if (created?.id) {
        database.database_id = created.id;
      }
    }
  }
}

function refreshComponentDigests(plan) {
  const configDigests = {};
  for (const component of plan.components) {
    component.configSha256 = sha256Hex(stableJson(component.generatedConfig));
    configDigests[component.name] = component.configSha256;
  }
  plan.manifestDraft.build.deployment.configSha256 = sha256Hex(stableJson(configDigests));
  plan.planSha256 = sha256Hex(stableJson(stripGeneratedConfig(plan)));
}

async function applyActualPreviewOrigins(api, plan) {
  const primary = plan.components.find((component) => component.name === plan.primaryComponent);
  if (!primary) throw new Error(`Cloudflare preview primary component ${plan.primaryComponent} is missing`);
  const origin = await api.getWorkerPreviewUrl(primary.name);
  if (!origin) throw new Error(`Cloudflare preview URL could not be determined for ${primary.name}`);
  primary.actualPreviewUrl = origin;
  for (const component of plan.components) {
    component.generatedConfig.vars = {
      ...(component.generatedConfig.vars ?? {}),
      PUBLIC_ORIGIN: origin,
      NIB_ACCEPTANCE_ORIGIN: origin,
    };
  }
  refreshComponentDigests(plan);
}

async function applyWorkerOperations(api, plan, journal) {
  const deployed = [];
  for (const component of orderedComponentsForDeploy(plan.components)) {
    const prior = findJournalEntry(journal, "deploy-worker", component.name);
    if (prior?.result) {
      deployed.push(prior.result);
      continue;
    }
    const deployedComponent = await api.deployWorker(component);
    const result = {
      name: component.name,
      baseName: component.baseName,
      versionId: deployedComponent.versionId,
      deploymentId: deployedComponent.deploymentId,
      kind: component.kind,
      previewUrl: deployedComponent.previewUrl,
      configSha256: component.configSha256,
      assetsSha256: component.assetsSha256,
      stackSlug: component.stackSlug,
    };
    await appendJournalEntry(plan, journal, {
      key: "deploy-worker",
      target: component.name,
      action: "deploy-worker",
      type: "worker",
      result,
    });
    deployed.push(result);
  }
  return deployed;
}

function deploymentMatchesMessage(deployment, message) {
  const actual =
    deployment?.annotations?.["workers/message"] ??
    deployment?.annotations?.message ??
    deployment?.metadata?.message ??
    deployment?.message;
  return actual === message;
}

function orderedComponentsForDeploy(components) {
  const byName = new Map(components.map((component) => [component.name, component]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (component) => {
    if (visited.has(component.name)) return;
    if (visiting.has(component.name)) {
      throw new Error(`Cloudflare service binding cycle at ${component.name}`);
    }
    visiting.add(component.name);
    for (const service of component.generatedConfig.services ?? []) {
      const dependency = byName.get(service.service);
      if (dependency) visit(dependency);
    }
    visiting.delete(component.name);
    visited.add(component.name);
    ordered.push(component);
  };
  for (const component of components) visit(component);
  return ordered;
}

function buildManifestDraft(recipe, components, deployment) {
  const deployedComponents = deployment.deployedComponents ?? components.map((component) => ({
    name: component.name,
    versionId: "<pending>",
    kind: component.kind,
  }));
  return {
    contract: ACCEPTANCE_CONTRACT,
    projectId: requireString(recipe.projectId, "projectId"),
    subject: requireString(recipe.subject, "subject"),
    gate: requireString(recipe.gate, "gate"),
    title: requireString(recipe.title, "title"),
    request: requireString(recipe.request, "request"),
    change: requireString(recipe.change, "change"),
    criteria: recipe.criteria ?? [],
    build: {
      repository: recipe.build?.repository,
      commit: requireString(recipe.build?.commit ?? recipe.revision, "build.commit"),
      provider: "cloudflare",
      previewUrl: deployment.primaryPreviewUrl,
      deployment: {
        id: deployment.deploymentId ?? "<pending>",
        components: deployedComponents.map((component) => ({
          name: component.name,
          versionId: component.versionId,
          kind: component.kind,
        })),
        configSha256: deployment.configSha256,
        assetsSha256: deployment.assetsSha256,
      },
      assumptions: [
        "Cloudflare Worker versions capture code, static assets, bindings, and compatibility settings.",
        "D1, R2, Queue, and Durable Object storage state is isolated by per-revision resource names and seeded fixtures.",
        "Production routes, custom domains, triggers, email bindings, and service targets are removed or rewritten in preview configuration.",
      ],
    },
    evidence: recipe.evidence ?? [],
  };
}

function collectResourceState(plan, createdResources = []) {
  const createdByKey = new Map(createdResources.map((resource) => [resourceKey(resource.type, resource.name), resource]));
  return plan.operations
    .filter((operation) => operation.action === "create")
    .map((operation) => ({
      type: operation.type,
      name: operation.name,
      id: createdByKey.get(resourceKey(operation.type, operation.name))?.id,
      binding: operation.binding,
      component: operation.component,
    }));
}

function collectR2Objects(plan) {
  return plan.operations
    .filter((operation) => operation.action === "seed" && operation.type === "r2")
    .map((operation) => ({
      bucket: operation.name,
      key: operation.key,
      file: operation.file,
      component: operation.component,
    }));
}

function buildLocalState(plan, manifest, deployedComponents, createdResources, journal, materialized) {
  const state = {
    contract: PREVIEW_CONTRACT,
    stackSlug: plan.stackSlug,
    planSha256: plan.planSha256,
    journalPlanSha256: journal.planSha256,
    manifestHash: sha256Hex(stableJson(manifest)),
    primaryComponent: plan.primaryComponent,
    createdAt: new Date().toISOString(),
    manifest,
    components: deployedComponents.map((component) => ({
      name: component.name,
      baseName: component.baseName,
      versionId: component.versionId,
      deploymentId: component.deploymentId,
      kind: component.kind,
      previewUrl: component.previewUrl,
      stackSlug: component.stackSlug,
    })),
    resources: collectResourceState(plan, createdResources),
    r2Objects: collectR2Objects(plan),
    materialized,
    journalPath: journal.path,
  };
  state.ownershipSha256 = ownershipDigest(state);
  return state;
}

async function validateOwnedStateForTeardown(state) {
  if (state.ownershipSha256 !== ownershipDigest(state)) {
    throw new Error("Cloudflare preview teardown state ownership digest does not match its contents");
  }
  if (state.manifestHash !== sha256Hex(stableJson(state.manifest))) {
    throw new Error("Cloudflare preview teardown state manifest hash does not match its manifest");
  }
  const journalPath = requireString(state.journalPath, "state.journalPath");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  if (
    journal.contract !== PREVIEW_CONTRACT ||
    journal.stackSlug !== state.stackSlug ||
    journal.planSha256 !== state.journalPlanSha256
  ) {
    throw new Error("Cloudflare preview teardown journal does not match owned state");
  }
  const planPath = requireString(state.materialized?.planPath, "state.materialized.planPath");
  const planSnapshot = JSON.parse(await readFile(planPath, "utf8"));
  if (planSnapshot.contract !== PREVIEW_CONTRACT || planSnapshot.stackSlug !== state.stackSlug || planSnapshot.planSha256 !== state.planSha256) {
    throw new Error("Cloudflare preview teardown materialized plan does not match owned state");
  }
  for (const migration of planSnapshot.operations?.filter((operation) => operation.action === "migrate" && operation.type === "d1") ?? []) {
    const createEntry = findJournalEntry(journal, `${state.stackSlug}:d1:${migration.name}`, migration.name);
    const migrationEntry = findJournalEntry(journal, migration.idempotencyKey, migration.name);
    if (!createEntry?.result?.id || migrationEntry?.result?.databaseId !== createEntry.result.id || migrationEntry?.result?.migrationsSha256 !== migration.migrationsSha256) {
      throw new Error(`Cloudflare preview teardown journal is missing D1 migration proof for ${migration.name}`);
    }
  }
  for (const component of state.components ?? []) {
    const entry = findJournalEntry(journal, "deploy-worker", component.name);
    if (!entry?.result || entry.result.versionId !== component.versionId || entry.result.deploymentId !== component.deploymentId) {
      throw new Error(`Cloudflare preview teardown journal is missing deployed Worker ${component.name}`);
    }
  }
  for (const resource of state.resources ?? []) {
    const entry = journal.operations?.find((operation) =>
      operation.action === "create" &&
      operation.status === "succeeded" &&
      operation.type === resource.type &&
      operation.target === resource.name
    );
    if (!entry?.result) {
      throw new Error(`Cloudflare preview teardown journal is missing resource ${resource.name}`);
    }
  }
}

function ownershipDigest(state) {
  return sha256Hex(stableJson({
    stackSlug: state.stackSlug,
    planSha256: state.planSha256,
    journalPlanSha256: state.journalPlanSha256,
    manifestHash: state.manifestHash,
    primaryComponent: state.primaryComponent,
    components: state.components,
    resources: state.resources,
    r2Objects: state.r2Objects,
  }));
}

function assertOwnedNames(state) {
  for (const component of state.components ?? []) {
    if (component.stackSlug !== state.stackSlug || !component.name.includes("-acc-")) {
      throw new Error(`Refusing teardown for unowned Worker name: ${component.name}`);
    }
  }
  for (const resource of state.resources ?? []) {
    if (!resource.name.includes("-acc-")) {
      throw new Error(`Refusing teardown for unowned ${resource.type} resource: ${resource.name}`);
    }
  }
  for (const object of state.r2Objects ?? []) {
    if (!object.bucket.includes("-acc-")) {
      throw new Error(`Refusing teardown for unowned R2 object bucket: ${object.bucket}`);
    }
  }
}

async function hashComponentAssets(root, config, component, configPath) {
  const assetPaths = [...(component.assets ?? [])];
  if (config.assets?.directory) assetPaths.push(path.resolve(path.dirname(configPath), config.assets.directory));
  if (assetPaths.length === 0) return { sha256: undefined, missing: [] };
  return hashPaths(assetPaths.map((entry) => path.resolve(root, entry)));
}

async function hashPaths(paths) {
  const hash = createHash("sha256");
  const missing = [];
  let hashed = false;
  for (const target of paths.sort()) {
    const files = await listFiles(target).catch((error) => {
      if (error.code === "ENOENT") {
        missing.push(target);
        return [];
      }
      throw error;
    });
    for (const file of files) {
      hashed = true;
      hash.update(path.relative(target, file));
      hash.update("\0");
      hash.update(await readFile(file));
      hash.update("\0");
    }
  }
  return { sha256: hashed ? hash.digest("hex") : undefined, missing };
}

async function listFiles(target) {
  const info = await stat(target);
  if (info.isFile()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const child = path.join(target, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  }));
  return nested.flat().sort();
}

function parseJsonc(source) {
  return JSON.parse(stripJsonComments(source));
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        inString = false;
      }
      continue;
    }
    if (current === "\"" || current === "'") {
      inString = true;
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildStackSlug(recipe, revision) {
  const base = `${recipe.projectId}-${recipe.subject}-${recipe.gate}-${revision}`;
  return `${slug(recipe.subject).slice(0, 18)}-${sha256Hex(base).slice(0, 12)}`;
}

function buildName(baseName, stackSlug) {
  const normalized = slug(baseName);
  const suffix = stackSlug.slice(-12);
  return truncateName(`${normalized}-acc-${suffix}`);
}

function buildResourceName(baseName, stackSlug) {
  return truncateName(`${slug(baseName)}-acc-${stackSlug.slice(-12)}`);
}

function truncateName(name, maxLength = 63) {
  if (name.length <= maxLength) return name;
  const hash = sha256Hex(name).slice(0, 10);
  return `${name.slice(0, maxLength - hash.length - 1)}-${hash}`;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-") || "preview";
}

function normalizeRevision(value) {
  return requireString(value, "revision").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
}

function hasStatefulBindings(config) {
  return Boolean(
    config.durable_objects?.bindings?.length ||
    config.d1_databases?.length ||
    config.r2_buckets?.length ||
    config.queues?.producers?.length ||
    config.queues?.consumers?.length
  );
}

function assertNoProductionBindingNames(config, componentName) {
  const names = [
    ...(config.d1_databases ?? []).map((entry) => entry.database_name),
    ...(config.r2_buckets ?? []).map((entry) => entry.bucket_name),
    ...(config.queues?.producers ?? []).map((entry) => entry.queue),
    ...(config.queues?.consumers ?? []).map((entry) => entry.queue),
    ...(config.services ?? []).map((entry) => entry.service),
  ].filter(Boolean);
  for (const name of names) {
    if (!String(name).includes("-acc-")) {
      throw new Error(`${componentName} preview config still references non-preview Cloudflare binding target: ${name}`);
    }
  }
}

function dedupeOperations(operations) {
  const seen = new Set();
  const deduped = [];
  for (const operation of operations) {
    const key = `${operation.action}:${operation.type}:${operation.name}:${operation.file ?? ""}:${operation.key ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(operation);
  }
  return deduped;
}

function findD1Name(config, binding) {
  const database = (config.d1_databases ?? []).find((entry) => entry.binding === binding);
  if (!database) throw new Error(`No D1 binding named ${binding}`);
  return database.database_name;
}

function findR2Name(config, binding) {
  const bucket = (config.r2_buckets ?? []).find((entry) => entry.binding === binding);
  if (!bucket) throw new Error(`No R2 binding named ${binding}`);
  return bucket.bucket_name;
}

function previewUrlTemplate(workerName, stackSlug) {
  return `https://${stackSlug}-${workerName}.workers.dev`;
}

function stripGeneratedConfig(plan) {
  return {
    ...plan,
    components: plan.components.map((component) => ({
      ...component,
      generatedConfig: undefined,
    })),
  };
}

function resourceKey(type, name) {
  return `${type}:${name}`;
}

function resourceApiPath(type) {
  if (type === "d1") return "d1/database";
  if (type === "r2") return "r2/buckets";
  if (type === "queue") return "queues";
  throw new Error(`Unsupported resource type: ${type}`);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

async function readJsonResponse(response) {
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok || json.success === false) {
    const message = json.error?.message ?? json.errors?.[0]?.message ?? response.statusText;
    throw new Error(message);
  }
  return json;
}
