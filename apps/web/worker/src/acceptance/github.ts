import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { AcceptanceError, type AcceptanceManifest } from "./contracts";
import { hasFreshProviderVerification } from "./provider-verification";
import {
  type AcceptanceAccount,
  type AcceptanceChangedEvent,
  type AcceptanceIntegrationEnv,
  type AutomationActor,
  acceptanceEnabled,
  acceptanceCoordinator,
  fetchCurrentAcceptanceState,
  integerString,
  json,
  jsonError,
  readBoundedText,
  readJsonObject,
  requireIdempotencyKey,
  sha256Hex,
  stringArray,
  stringValue,
  verifyHmacSha256,
  withAtomicIdempotency,
  ensureProjectAdmin,
} from "./common";

const GITHUB_WEBHOOK_LEASE_TIMEOUT_SECONDS = 300;

interface GitHubInstallationConfig {
  id: string;
  project_id: string;
  installation_id: string;
  repository_id: string;
  repository_owner: string;
  repository_name: string;
  allowed_workflows_json: string;
  gates_json: string | null;
  enabled: number;
  created_at?: number;
  updated_at?: number;
}

interface GitHubCheckHeadRow extends GitHubInstallationConfig {
  config_id: string;
  gate: string;
  head_sha: string;
  latest_sequence: number;
  event_id: string;
  payload_json: string;
  last_conclusion: string | null;
  cursor_key: string;
}

interface GitHubRepositoryResponse {
  id?: number;
  name?: string;
  default_branch?: string;
  owner?: { login?: string };
}

interface GitHubInstallationTokenResponse {
  token?: string;
  expires_at?: string;
}

interface GitHubWebhookDeliveryClaim {
  eventName: string;
  payload: string;
}

interface GitHubOidcClaims extends JWTPayload {
  repository?: string;
  repository_id?: string;
  workflow_ref?: string;
  job_workflow_ref?: string;
  sha?: string;
  ref?: string;
  actor?: string;
  event_name?: string;
}

export interface GitHubWorkflowActor extends AutomationActor {
  provider: "github";
  repositoryId: string;
  repository: string;
  repositoryOwner: string;
  repositoryName: string;
  workflowRef: string;
  jobWorkflowRef?: string;
  sha: string;
  ref: string;
  githubActor?: string;
  eventName?: string;
}

export function assertGithubPublication(actor: AutomationActor | GitHubWorkflowActor | null | undefined, manifest: AcceptanceManifest): void {
  if (!isGitHubWorkflowActor(actor)) return;
  const repository = manifest.build.repository;
  if (!repository) throw githubPublicationError("GitHub workflow publications must include manifest.build.repository.");
  if (repository.id !== actor.repositoryId) throw githubPublicationError("GitHub workflow repository id does not match the manifest.");
  if (repository.owner.toLowerCase() !== actor.repositoryOwner.toLowerCase() ||
      repository.name.toLowerCase() !== actor.repositoryName.toLowerCase()) {
    throw githubPublicationError("GitHub workflow repository name does not match the manifest.");
  }
  if (manifest.build.commit !== actor.sha) throw githubPublicationError("GitHub workflow SHA does not match the manifest commit.");
  const pullNumber = actor.ref.match(/^refs\/pull\/(\d+)\//)?.[1];
  if (pullNumber) {
    const expectedSubject = `github:${actor.repository}:pull/${pullNumber}`;
    if (manifest.subject !== expectedSubject) throw githubPublicationError("GitHub pull request subject does not match the workflow ref.");
  }
}

function githubPublicationError(message: string): AcceptanceError {
  return new AcceptanceError(403, "GITHUB_PROVENANCE_MISMATCH", message);
}

const API_PREFIX = "/api/acceptance/v1";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const DEFAULT_OIDC_AUDIENCE = "nib.acceptance/v1";
const CHECK_NAME_PREFIX = "nib acceptance";

export async function handleGitHubIntegrationRoute(
  request: Request,
  env: AcceptanceIntegrationEnv,
  account: AcceptanceAccount | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === `${API_PREFIX}/github/webhook` && request.method === "POST") {
    return handleGitHubWebhook(request, env);
  }
  if (url.pathname === `${API_PREFIX}/github/token` && request.method === "POST") {
    return exchangeGitHubWorkflowToken(request, env);
  }

  const match = url.pathname.match(/^\/api\/acceptance\/v1\/projects\/([^/]+)\/integrations\/github$/);
  if (!match) return null;
  const projectId = decodeURIComponent(match[1] ?? "");
  if (!projectId) return jsonError("not_found", "Project not found.", 404);
  if (!acceptanceEnabled(env)) return jsonError("acceptance_disabled", "Acceptance is disabled.", 403);
  if (!(await ensureProjectAdmin(env.DB, projectId, account))) {
    return jsonError("forbidden", "Project admin access is required.", 403);
  }

  if (request.method === "GET") return listGitHubInstallations(projectId, env);
  if (request.method === "PUT" || request.method === "POST") return upsertGitHubInstallation(request, env, projectId, account);
  if (request.method === "DELETE") return deleteGitHubInstallation(request, env, projectId);
  return jsonError("method_not_allowed", "Method not allowed.", 405);
}

export async function authenticateGithubWorkflow(db: D1Database, bearerToken: string): Promise<GitHubWorkflowActor | null> {
  const token = bearerToken.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT t.actor_id, t.project_id, t.scopes_json, t.repository_id, t.repository, t.workflow_ref,
            t.job_workflow_ref, t.sha, t.ref, t.event_name, t.github_actor,
            gi.allowed_workflows_json, gi.gates_json, gi.enabled
       FROM acceptance_github_workflow_tokens t
       JOIN acceptance_github_installations gi
         ON gi.project_id = t.project_id
        AND gi.repository_id = t.repository_id
        AND gi.enabled = 1
      WHERE t.token_hash = ?
        AND t.revoked_at IS NULL
        AND t.expires_at > unixepoch()
      LIMIT 1`,
  ).bind(tokenHash).first<{
    actor_id: string;
    project_id: string;
    scopes_json: string;
    repository_id: string;
    repository: string;
    workflow_ref: string;
    job_workflow_ref: string | null;
    sha: string | null;
    ref: string | null;
    event_name: string | null;
    github_actor: string | null;
    allowed_workflows_json: string;
    gates_json: string | null;
    enabled: number;
  }>();
  if (!row) return null;
  if (!workflowAllowed(row, row.workflow_ref, row.job_workflow_ref)) return null;
  const [repositoryOwner, repositoryName] = splitRepository(row.repository);
  return {
    id: row.actor_id,
    projectId: row.project_id,
    scopes: parseJsonArray(row.scopes_json),
    provider: "github",
    repositoryId: row.repository_id,
    repository: row.repository,
    repositoryOwner,
    repositoryName,
    workflowRef: row.workflow_ref,
    ...(row.job_workflow_ref ? { jobWorkflowRef: row.job_workflow_ref } : {}),
    sha: row.sha ?? "",
    ref: row.ref ?? "",
    ...(row.event_name ? { eventName: row.event_name } : {}),
    ...(row.github_actor ? { githubActor: row.github_actor } : {}),
  };
}

export async function handleGitHubWebhook(request: Request, env: AcceptanceIntegrationEnv): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) return jsonError("github_webhook_unconfigured", "GitHub webhook secret is not configured.", 503);
  let payload: string;
  try {
    payload = await readBoundedText(request, 2 * 1024 * 1024);
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    if (status === 413) return jsonError("body_too_large", "GitHub webhook payload exceeds the 2 MiB limit.", 413);
    throw error;
  }
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!signature || !(await verifyHmacSha256(env.GITHUB_WEBHOOK_SECRET, payload, signature, "sha256="))) {
    return jsonError("invalid_signature", "GitHub webhook signature did not match.", 401);
  }

  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  const eventName = request.headers.get("x-github-event")?.trim();
  if (!deliveryId || !eventName) return jsonError("invalid_webhook", "GitHub webhook delivery headers are required.", 400);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO acceptance_github_webhook_deliveries(id, event_name, payload_json, state, received_at)
     VALUES (?, ?, ?, 'received', unixepoch())`,
  ).bind(deliveryId, eventName, payload).run();

  const claim = await claimGitHubDelivery(deliveryId, env);
  if (claim === "replayed") return json({ ok: true, replayed: true });
  if (claim === "busy") {
    return jsonError(
      "webhook_delivery_in_progress",
      "GitHub webhook delivery is already being processed and should be retried.",
      503,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(claim.payload) as Record<string, unknown>;
  } catch {
    await markGitHubDelivery(deliveryId, env, "invalid_json");
    return jsonError("invalid_json", "GitHub webhook payload was not valid JSON.", 400);
  }

  try {
    await consumeGitHubEvent(claim.eventName, parsed, env);
    await markGitHubDelivery(deliveryId, env, "processed");
    return json({ ok: true });
  } catch (error) {
    await markGitHubDelivery(deliveryId, env, "failed");
    throw error;
  }
}

export async function publishGitHubChecksForAcceptanceEvent(
  event: AcceptanceChangedEvent,
  env: AcceptanceIntegrationEnv,
): Promise<void> {
  const current = await fetchCurrentAcceptanceState(env, event);
  if (!current || current.reviewId !== event.reviewId || current.revision !== event.revision ||
      current.manifestHash !== event.manifestHash) {
    return;
  }
  const repository = event.manifest.build.repository;
  if (!repository) return;

  const configs = await env.DB.prepare(
    `SELECT *
       FROM acceptance_github_installations
      WHERE project_id = ? AND repository_id = ? AND enabled = 1`,
  ).bind(event.projectId, repository.id).all<GitHubInstallationConfig>();

  for (const config of configs.results) {
    if (!gateEnabled(config, event.gate)) continue;
    if (!(await claimLatestCheckHead(env, config, event))) continue;
    await createGitHubCheckRun(env, config, event, await githubCheckState(env, event, current.state ?? event.state));
  }
}

export async function refreshGitHubChecksForReview(
  env: AcceptanceIntegrationEnv,
  projectId: string,
  reviewId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT payload_json
       FROM acceptance_integration_events
      WHERE project_id = ? AND review_id = ?
      ORDER BY sequence DESC, received_at DESC
      LIMIT 1`,
  ).bind(projectId, reviewId).first<{ payload_json: string }>();
  const event = row ? parseStoredEvent(row.payload_json) : null;
  if (!event) return;
  await publishGitHubChecksForAcceptanceEvent(event, env);
}

export async function reconcileGitHubAcceptanceChecks(
  env: AcceptanceIntegrationEnv,
  limit = 100,
): Promise<void> {
  const cursor = await env.DB.prepare(
    "SELECT cursor_updated_at, cursor_key FROM acceptance_github_reconcile_cursors WHERE id = 'github-checks'",
  ).first<{ cursor_updated_at: number; cursor_key: string }>();
  const page = await githubReconcilePage(env, cursor?.cursor_updated_at ?? 0, cursor?.cursor_key ?? "", limit);
  const rows = page.results.length ? page.results : (cursor ? (await githubReconcilePage(env, 0, "", limit)).results : []);
  for (const row of rows) {
    const event = parseStoredEvent(row.payload_json);
    if (!event) continue;
    if (!acceptanceEnabled(env)) {
      await createGitHubCheckRun(env, row, event, "rejected");
      continue;
    }
    const current = await fetchCurrentAcceptanceState(env, event);
    const stillCurrent = current?.reviewId === event.reviewId &&
      current.revision === event.revision &&
      current.manifestHash === event.manifestHash &&
      current.state === "approved";
    const checkState = stillCurrent
      ? await githubCheckState(env, event, "approved")
      : current?.state ?? "invalidated";
    const desiredConclusion = checkConclusion(checkState) ?? "in_progress";
    if (!stillCurrent || checkState !== "approved" || row.last_conclusion !== desiredConclusion) {
      await createGitHubCheckRun(env, row, event, checkState);
    }
  }
  const last = rows.at(-1);
  if (last) {
    await env.DB.prepare(
      `INSERT INTO acceptance_github_reconcile_cursors(id, cursor_updated_at, cursor_key, updated_at)
       VALUES ('github-checks', ?, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         cursor_updated_at = excluded.cursor_updated_at,
         cursor_key = excluded.cursor_key,
         updated_at = unixepoch()`,
    ).bind(last.updated_at ?? 0, last.cursor_key).run();
  } else if (cursor) {
    await env.DB.prepare(
      "UPDATE acceptance_github_reconcile_cursors SET cursor_updated_at = 0, cursor_key = '', updated_at = unixepoch() WHERE id = 'github-checks'",
    ).run();
  }
}

async function githubCheckState(
  env: AcceptanceIntegrationEnv,
  event: AcceptanceChangedEvent,
  state: string,
): Promise<string> {
  if (state !== "approved") return state;
  if (await hasFreshProviderVerification(env.DB, {
    projectId: event.projectId,
    id: event.reviewId,
    manifestHash: event.manifestHash,
    manifest: event.manifest,
  })) return state;
  return "cloudflare_current_version_unverified";
}

async function claimLatestCheckHead(
  env: AcceptanceIntegrationEnv,
  config: GitHubInstallationConfig,
  event: AcceptanceChangedEvent,
): Promise<boolean> {
  const claimId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO acceptance_github_check_heads(
       config_id, gate, head_sha, latest_sequence, event_id, claim_id, updated_at
     ) VALUES (?, ?, ?, 0, ?, ?, unixepoch())`,
  ).bind(config.id, event.gate, event.manifest.build.commit, event.id, claimId).run();
  const claimed = await env.DB.prepare(
    `UPDATE acceptance_github_check_heads
        SET latest_sequence = ?,
            event_id = ?,
            claim_id = ?,
            updated_at = unixepoch()
      WHERE config_id = ?
        AND gate = ?
        AND head_sha = ?
        AND latest_sequence <= ?`,
  ).bind(
    event.sequence,
    event.id,
    claimId,
    config.id,
    event.gate,
    event.manifest.build.commit,
    event.sequence,
  ).run();
  return Boolean(claimed.meta.changes);
}

async function createGitHubCheckRun(
  env: AcceptanceIntegrationEnv,
  config: Pick<GitHubInstallationConfig, "id" | "installation_id" | "repository_id" | "repository_owner" | "repository_name">,
  event: AcceptanceChangedEvent,
  state: string,
): Promise<void> {
  const token = await installationToken(config.installation_id, env);
  const body = checkRunBody(event, state);
  const response = await githubFetch(
    env,
    `/repos/${encodeURIComponent(config.repository_owner)}/${encodeURIComponent(config.repository_name)}/check-runs`,
    {
      method: "POST",
      token,
      body,
    },
  );
  const result: { id?: number; html_url?: string } = await response.json<{ id?: number; html_url?: string }>().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub check publication failed (${response.status})`);
  const repository = event.manifest.build.repository;
  await env.DB.prepare(
    `INSERT INTO acceptance_github_check_runs(
       id, config_id, event_id, project_id, review_id, gate, repository_id, head_sha, check_run_id,
       check_url, conclusion, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(config_id, event_id) DO UPDATE SET
       check_run_id = excluded.check_run_id,
       check_url = excluded.check_url,
       conclusion = excluded.conclusion`,
  ).bind(
    crypto.randomUUID(),
    config.id,
    event.id,
    event.projectId,
    event.reviewId,
    event.gate,
    repository?.id ?? config.repository_id,
    event.manifest.build.commit,
    result.id ? String(result.id) : null,
    result.html_url ?? null,
    body.conclusion ?? body.status,
  ).run();
}

async function githubReconcilePage(
  env: AcceptanceIntegrationEnv,
  cursorUpdatedAt: number,
  cursorKey: string,
  limit: number,
): Promise<{ results: GitHubCheckHeadRow[] }> {
  return env.DB.prepare(
    `SELECT gi.id, gi.project_id, gi.installation_id, gi.repository_id, gi.repository_owner, gi.repository_name,
            gi.allowed_workflows_json, gi.gates_json, gi.enabled, gi.created_at, gi.updated_at,
            h.config_id, h.gate, h.head_sha, h.latest_sequence, h.event_id, e.payload_json,
            cr.conclusion AS last_conclusion,
            (h.config_id || ':' || h.gate || ':' || h.head_sha) AS cursor_key
       FROM acceptance_github_check_heads h
       JOIN acceptance_github_installations gi ON gi.id = h.config_id
       JOIN acceptance_integration_events e ON e.id = h.event_id
       LEFT JOIN acceptance_github_check_runs cr ON cr.config_id = h.config_id AND cr.event_id = h.event_id
      WHERE gi.enabled = 1
        AND (h.updated_at > ? OR (h.updated_at = ? AND (h.config_id || ':' || h.gate || ':' || h.head_sha) > ?))
      ORDER BY h.updated_at, h.config_id, h.gate, h.head_sha
      LIMIT ?`,
  ).bind(cursorUpdatedAt, cursorUpdatedAt, cursorKey, Math.max(1, Math.min(limit, 100))).all<GitHubCheckHeadRow>();
}

function parseStoredEvent(payload: string): AcceptanceChangedEvent | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "acceptance.changed") return null;
    return parsed as AcceptanceChangedEvent;
  } catch {
    return null;
  }
}

async function listGitHubInstallations(projectId: string, env: AcceptanceIntegrationEnv): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, installation_id, repository_id, repository_owner, repository_name,
            allowed_workflows_json, gates_json, enabled, created_at, updated_at
       FROM acceptance_github_installations
      WHERE project_id = ?
      ORDER BY repository_owner, repository_name`,
  ).bind(projectId).all<Record<string, unknown>>();
  return json({ installations: rows.results.map(installationResponse) });
}

async function upsertGitHubInstallation(
  request: Request,
  env: AcceptanceIntegrationEnv,
  projectId: string,
  account: AcceptanceAccount | null,
): Promise<Response> {
  const key = requireIdempotencyKey(request);
  if (key instanceof Response) return key;
  const input = await readJsonObject(request);
  if (!input) return jsonError("invalid_json", "JSON object body is required.", 400);

  const installationId = integerString(input.installationId ?? input.installation_id);
  const repositoryId = integerString(input.repositoryId ?? input.repository_id);
  const owner = stringValue(input.owner ?? input.repositoryOwner ?? input.repository_owner);
  const name = stringValue(input.name ?? input.repositoryName ?? input.repository_name);
  const allowedWorkflows = stringArray(input.allowedWorkflows ?? input.allowed_workflows);
  const gates = stringArray(input.gates);
  const ownershipOidcToken = stringValue(input.ownershipOidcToken ?? input.ownership_oidc_token);
  if (!installationId || !repositoryId || !owner || !name) {
    return jsonError("invalid_github_installation", "installationId, repositoryId, owner, and name are required.", 400);
  }
  if (allowedWorkflows.length === 0) {
    return jsonError("workflow_scope_required", "At least one allowed GitHub workflow ref is required.", 400);
  }
  if (!ownershipOidcToken) {
    return jsonError("github_ownership_proof_required", "A GitHub OIDC ownership proof from the target repository default branch is required.", 403);
  }

  const verified = await verifyInstallationRepository({ installationId, repositoryId, owner, name }, env);
  const proof = await verifyGitHubOwnershipProof(ownershipOidcToken, {
    repositoryId,
    owner: verified.owner,
    name: verified.name,
    defaultBranch: verified.defaultBranch,
    allowedWorkflows,
  }, env);
  if (proof instanceof Response) return proof;
  const existing = await env.DB.prepare(
    "SELECT * FROM acceptance_github_installations WHERE project_id = ? AND repository_id = ?",
  ).bind(projectId, repositoryId).first<GitHubInstallationConfig>();
  const id = existing?.id ?? `github-${(await sha256Hex(`${projectId}:${repositoryId}`)).slice(0, 32)}`;
  const row: GitHubInstallationConfig = {
    id,
    project_id: projectId,
    installation_id: installationId,
    repository_id: repositoryId,
    repository_owner: verified.owner,
    repository_name: verified.name,
    allowed_workflows_json: JSON.stringify(allowedWorkflows),
    gates_json: gates.length ? JSON.stringify(gates) : null,
    enabled: 1,
    created_at: existing?.created_at,
    updated_at: existing?.updated_at,
  };
  const response = { installation: installationResponse(row) };
  const mutation = env.DB.prepare(
    `INSERT INTO acceptance_github_installations(
       id, project_id, installation_id, repository_id, repository_owner, repository_name,
       allowed_workflows_json, gates_json, enabled, created_by_account_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch())
     ON CONFLICT(project_id, repository_id) DO UPDATE SET
       installation_id = excluded.installation_id,
       repository_owner = excluded.repository_owner,
       repository_name = excluded.repository_name,
       allowed_workflows_json = excluded.allowed_workflows_json,
       gates_json = excluded.gates_json,
       enabled = 1,
       updated_at = unixepoch()`,
  ).bind(
    id,
    projectId,
    installationId,
    repositoryId,
    verified.owner,
    verified.name,
    JSON.stringify(allowedWorkflows),
    gates.length ? JSON.stringify(gates) : null,
    account?.id ?? null,
  );
  const stored = await withAtomicIdempotency(
    env.DB,
    projectId,
    "github.installation.upsert",
    key,
    await sha256Hex(JSON.stringify({ installationId, repositoryId, owner: verified.owner, name: verified.name, defaultBranch: verified.defaultBranch, allowedWorkflows, gates, proof: proof.workflowRef })),
    response,
    [mutation],
  );
  return json(stored.result, 200);
}

async function deleteGitHubInstallation(request: Request, env: AcceptanceIntegrationEnv, projectId: string): Promise<Response> {
  const key = requireIdempotencyKey(request);
  if (key instanceof Response) return key;
  const url = new URL(request.url);
  const repositoryId = integerString(url.searchParams.get("repository_id") ?? url.searchParams.get("repositoryId"));
  if (!repositoryId) return jsonError("repository_required", "repository_id is required.", 400);
  const mutation = env.DB.prepare(
    "UPDATE acceptance_github_installations SET enabled = 0, updated_at = unixepoch() WHERE project_id = ? AND repository_id = ?",
  ).bind(projectId, repositoryId);
  const revokeTokens = env.DB.prepare(
    "UPDATE acceptance_github_workflow_tokens SET revoked_at = COALESCE(revoked_at, unixepoch()) WHERE project_id = ? AND repository_id = ? AND revoked_at IS NULL",
  ).bind(projectId, repositoryId);
  const stored = await withAtomicIdempotency(
    env.DB,
    projectId,
    "github.installation.delete",
    key,
    await sha256Hex(JSON.stringify({ repositoryId })),
    { ok: true },
    [mutation, revokeTokens],
  );
  return json(stored.result);
}

async function exchangeGitHubWorkflowToken(request: Request, env: AcceptanceIntegrationEnv): Promise<Response> {
  if (!acceptanceEnabled(env)) return jsonError("acceptance_disabled", "Acceptance is disabled.", 403);
  const key = requireIdempotencyKey(request);
  if (key instanceof Response) return key;
  const input = await readJsonObject(request);
  const oidcToken = stringValue(input?.oidcToken ?? input?.oidc_token ?? input?.token);
  const requestedProjectId = stringValue(input?.projectId ?? input?.project_id);
  const requestedMode = stringValue(input?.mode);
  if (!oidcToken) return jsonError("oidc_token_required", "GitHub OIDC token is required.", 400);

  const claims = await verifyGitHubOidcToken(oidcToken, env);
  const repositoryId = integerString(claims.repository_id);
  const workflowRef = stringValue(claims.workflow_ref);
  const jobWorkflowRef = stringValue(claims.job_workflow_ref);
  const repository = stringValue(claims.repository);
  const sha = stringValue(claims.sha);
  const ref = stringValue(claims.ref);
  const claimError = validateGitHubWorkflowClaims({ repositoryId, workflowRef, repository, sha, ref });
  if (claimError) return jsonError("invalid_oidc_claims", claimError, 401);
  if (!repositoryId || !workflowRef || !repository || !sha || !ref) return jsonError("invalid_oidc_claims", "GitHub OIDC claims are incomplete.", 401);

  const rows = await env.DB.prepare(
    `SELECT *
       FROM acceptance_github_installations
      WHERE repository_id = ?
        AND enabled = 1
        AND (? IS NULL OR project_id = ?)`,
  ).bind(repositoryId, requestedProjectId, requestedProjectId).all<GitHubInstallationConfig>();
  const config = rows.results.find((row) => workflowAllowed(row, workflowRef, jobWorkflowRef));
  if (!config) return jsonError("workflow_not_linked", "GitHub workflow is not linked to the requested project.", 403);

  if (requestedMode !== "publish" && requestedMode !== "verify") {
    return jsonError("invalid_workflow_token_mode", "GitHub workflow token mode must be publish or verify.", 400);
  }
  const scopes = requestedMode === "verify" ? ["verify"] : ["publish"];
  const token = base64UrlRandom(32);
  const tokenHash = await sha256Hex(token);
  const actorId = `github:${config.repository_id}:${workflowRef}`;
  const [repositoryOwner, repositoryName] = splitRepository(repository);
  const eventName = stringValue(claims.event_name);
  const githubActor = stringValue(claims.actor);
  const response = {
    token_type: "Bearer",
    access_token: token,
    expires_in: 600,
    project_id: config.project_id,
    scopes,
    provenance: {
      provider: "github",
      repositoryId,
      repository,
      repositoryOwner,
      repositoryName,
      workflowRef,
      jobWorkflowRef,
      sha,
      ref,
      eventName,
      githubActor,
    },
  };
  const tokenInsert = env.DB.prepare(
    `INSERT INTO acceptance_github_workflow_tokens(
       token_hash, actor_id, project_id, scopes_json, repository_id, repository, workflow_ref,
       job_workflow_ref, sha, ref, event_name, github_actor, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch() + 600, unixepoch())`,
  ).bind(
    tokenHash,
    actorId,
    config.project_id,
    JSON.stringify(scopes),
    repositoryId,
    repository,
    workflowRef,
    jobWorkflowRef,
    sha,
    ref,
    eventName,
    githubActor,
  );
  const fingerprint = await sha256Hex(JSON.stringify({
    projectId: config.project_id,
    requestedProjectId,
    requestedMode,
    repositoryId,
    repository,
    workflowRef,
    jobWorkflowRef,
    sha,
    ref,
    eventName,
    githubActor,
    scopes,
  }));
  const stored = await withAtomicIdempotency(
    env.DB,
    config.project_id,
    "github.workflow.token",
    key,
    fingerprint,
    response,
    [tokenInsert],
  );
  return json(stored.result);
}

export function validateGitHubWorkflowClaims(claims: {
  repositoryId: string | null;
  workflowRef: string | null;
  repository: string | null;
  sha: string | null;
  ref: string | null;
}): string | null {
  if (!claims.repositoryId || !claims.workflowRef || !claims.repository) {
    return "GitHub OIDC token is missing repository or workflow claims.";
  }
  if (!claims.sha || !/^[0-9a-f]{40}$/i.test(claims.sha)) {
    return "GitHub OIDC token is missing a valid workflow SHA claim.";
  }
  if (!claims.ref || !claims.ref.startsWith("refs/")) {
    return "GitHub OIDC token is missing a valid workflow ref claim.";
  }
  return null;
}

async function consumeGitHubEvent(
  eventName: string,
  payload: Record<string, unknown>,
  env: AcceptanceIntegrationEnv,
): Promise<void> {
  if (eventName === "installation") {
    await consumeGitHubInstallationEvent(payload, env);
    return;
  }
  if (eventName === "installation_repositories") {
    await consumeGitHubInstallationRepositoriesEvent(payload, env);
    return;
  }
  if (eventName !== "pull_request") return;
  const action = stringValue(payload.action);
  if (!action || !["opened", "reopened", "synchronize"].includes(action)) return;
  const repository = objectValue(payload.repository);
  const pullRequest = objectValue(payload.pull_request);
  const head = objectValue(pullRequest?.head);
  const repoId = integerString(repository?.id);
  const owner = stringValue(objectValue(repository?.owner)?.login);
  const name = stringValue(repository?.name);
  const number = integerString(pullRequest?.number);
  const sha = stringValue(head?.sha);
  if (!repoId || !owner || !name || !number || !sha) return;

  const subject = `github:${owner}/${name}:pull/${number}`;
  const previous = await env.DB.prepare(
    "SELECT head_sha FROM acceptance_github_pull_heads WHERE repository_id = ? AND pull_number = ?",
  ).bind(repoId, number).first<{ head_sha: string }>();
  await env.DB.prepare(
    `INSERT INTO acceptance_github_pull_heads(repository_id, pull_number, head_sha, subject, updated_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(repository_id, pull_number) DO UPDATE SET
       head_sha = excluded.head_sha,
       subject = excluded.subject,
       updated_at = unixepoch()`,
  ).bind(repoId, number, sha, subject).run();
  await invalidatePullRequestCurrentReviews(env, repoId, subject, sha, previous?.head_sha !== sha);
}

async function consumeGitHubInstallationEvent(payload: Record<string, unknown>, env: AcceptanceIntegrationEnv): Promise<void> {
  const action = stringValue(payload.action);
  if (action !== "deleted" && action !== "suspend") return;
  const installationId = integerString(objectValue(payload.installation)?.id);
  if (!installationId) return;
  await revokeGitHubInstallation(env, installationId);
}

async function consumeGitHubInstallationRepositoriesEvent(payload: Record<string, unknown>, env: AcceptanceIntegrationEnv): Promise<void> {
  const action = stringValue(payload.action);
  if (action !== "removed") return;
  const installationId = integerString(objectValue(payload.installation)?.id);
  if (!installationId) return;
  const repositoryIds = repositoryIdsFromWebhookArray(payload.repositories_removed);
  if (repositoryIds.length === 0) return;
  for (const repositoryId of repositoryIds) await revokeGitHubRepository(env, installationId, repositoryId);
}

async function revokeGitHubInstallation(env: AcceptanceIntegrationEnv, installationId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE acceptance_github_workflow_tokens
          SET revoked_at = COALESCE(revoked_at, unixepoch())
        WHERE revoked_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM acceptance_github_installations gi
             WHERE gi.project_id = acceptance_github_workflow_tokens.project_id
               AND gi.repository_id = acceptance_github_workflow_tokens.repository_id
               AND gi.installation_id = ?
               AND gi.enabled = 1
          )`,
    ).bind(installationId),
    env.DB.prepare(
      "UPDATE acceptance_github_installations SET enabled = 0, updated_at = unixepoch() WHERE installation_id = ? AND enabled = 1",
    ).bind(installationId),
  ]);
}

async function revokeGitHubRepository(env: AcceptanceIntegrationEnv, installationId: string, repositoryId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE acceptance_github_workflow_tokens
          SET revoked_at = COALESCE(revoked_at, unixepoch())
        WHERE repository_id = ?
          AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM acceptance_github_installations gi
             WHERE gi.project_id = acceptance_github_workflow_tokens.project_id
               AND gi.repository_id = acceptance_github_workflow_tokens.repository_id
               AND gi.installation_id = ?
               AND gi.repository_id = ?
               AND gi.enabled = 1
          )`,
    ).bind(repositoryId, installationId, repositoryId),
    env.DB.prepare(
      "UPDATE acceptance_github_installations SET enabled = 0, updated_at = unixepoch() WHERE installation_id = ? AND repository_id = ? AND enabled = 1",
    ).bind(installationId, repositoryId),
  ]);
}

function repositoryIdsFromWebhookArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    const id = integerString(objectValue(item)?.id);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function invalidatePullRequestCurrentReviews(
  env: AcceptanceIntegrationEnv,
  repositoryId: string,
  subject: string,
  incomingSha: string,
  headChanged: boolean,
): Promise<void> {
  const configs = await env.DB.prepare(
    "SELECT project_id, gates_json FROM acceptance_github_installations WHERE repository_id = ? AND enabled = 1",
  ).bind(repositoryId).all<{ project_id: string; gates_json: string | null }>();
  for (const config of configs.results) {
    const gates = config.gates_json ? parseJsonArray(config.gates_json) : ["acceptance"];
    for (const gate of gates) {
      const coordinator = acceptanceCoordinator(env, config.project_id);
      const current = await coordinator?.getCurrent(subject, gate);
      if (!current || current.state === "superseded" || current.state === "invalidated") continue;
      const currentCommit = current.manifest?.build.commit;
      if (currentCommit ? currentCommit === incomingSha : !headChanged) continue;
      await coordinator?.invalidate(
        current.id,
        "GitHub pull request head changed.",
        "github:webhook",
        `github:pr-head:${repositoryId}:${numberForSubject(subject)}:${gate}:${current.id}`,
      );
    }
  }
}

async function verifyInstallationRepository(
  expected: { installationId: string; repositoryId: string; owner: string; name: string },
  env: AcceptanceIntegrationEnv,
): Promise<{ owner: string; name: string; defaultBranch: string }> {
  const token = await installationToken(expected.installationId, env);
  const response = await githubFetch(env, `/repositories/${expected.repositoryId}`, { method: "GET", token });
  if (!response.ok) throw new Error(`GitHub repository verification failed (${response.status})`);
  const repository = await response.json<GitHubRepositoryResponse>();
  const owner = repository.owner?.login;
  const defaultBranch = stringValue(repository.default_branch);
  if (String(repository.id ?? "") !== expected.repositoryId ||
      owner?.toLowerCase() !== expected.owner.toLowerCase() ||
      repository.name?.toLowerCase() !== expected.name.toLowerCase() ||
      !defaultBranch) {
    throw new Error("GitHub installation does not grant access to the requested repository");
  }
  return { owner, name: repository.name, defaultBranch };
}

async function verifyGitHubOwnershipProof(
  token: string,
  expected: { repositoryId: string; owner: string; name: string; defaultBranch: string; allowedWorkflows: string[] },
  env: AcceptanceIntegrationEnv,
): Promise<{ workflowRef: string } | Response> {
  let claims: GitHubOidcClaims;
  try {
    claims = await verifyGitHubOidcToken(token, env);
  } catch {
    return jsonError("github_ownership_proof_invalid", "GitHub ownership proof could not be verified.", 403);
  }
  const repositoryId = integerString(claims.repository_id);
  const workflowRef = stringValue(claims.workflow_ref);
  const repository = stringValue(claims.repository);
  const sha = stringValue(claims.sha);
  const ref = stringValue(claims.ref);
  const eventName = stringValue(claims.event_name);
  const claimError = validateGitHubWorkflowClaims({ repositoryId, workflowRef, repository, sha, ref });
  if (claimError || !repositoryId || !workflowRef || !repository || !sha || !ref) {
    return jsonError("github_ownership_proof_invalid", claimError ?? "GitHub ownership proof claims are incomplete.", 403);
  }
  const expectedRepository = `${expected.owner}/${expected.name}`;
  const expectedRef = `refs/heads/${expected.defaultBranch}`;
  if (repositoryId !== expected.repositoryId || repository.toLowerCase() !== expectedRepository.toLowerCase()) {
    return jsonError("github_ownership_proof_wrong_repository", "GitHub ownership proof must come from the repository being linked.", 403);
  }
  if (ref !== expectedRef) {
    return jsonError("github_ownership_proof_wrong_ref", "GitHub ownership proof must come from the repository default branch.", 403);
  }
  if (eventName !== "push" && eventName !== "workflow_dispatch") {
    return jsonError("github_ownership_proof_untrusted_event", "GitHub ownership proof must come from push or workflow_dispatch on the default branch.", 403);
  }
  if (!workflowRefAllowedForDefaultBranch(workflowRef, expected.owner, expected.name, expected.defaultBranch)) {
    return jsonError("github_ownership_proof_wrong_workflow", "GitHub ownership proof workflow must be from the target repository default branch.", 403);
  }
  if (!expected.allowedWorkflows.every((allowed) => workflowRefAllowedForDefaultBranch(allowed, expected.owner, expected.name, expected.defaultBranch))) {
    return jsonError("workflow_scope_invalid", "Allowed GitHub workflows must be from the target repository default branch.", 403);
  }
  if (!expected.allowedWorkflows.includes(workflowRef)) {
    return jsonError("github_ownership_proof_unlinked_workflow", "Allowed workflows must include the GitHub workflow that produced the ownership proof.", 403);
  }
  return { workflowRef };
}

function workflowRefAllowedForDefaultBranch(workflowRef: string, owner: string, name: string, defaultBranch: string): boolean {
  const normalized = workflowRef.toLowerCase();
  const prefix = `${owner}/${name}/.github/workflows/`.toLowerCase();
  return normalized.startsWith(prefix) && workflowRef.endsWith(`@refs/heads/${defaultBranch}`);
}

async function installationToken(installationId: string, env: AcceptanceIntegrationEnv): Promise<string> {
  const appJwt = await githubAppJwt(env);
  const response = await githubFetch(env, `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    token: appJwt,
    body: {},
  });
  if (!response.ok) throw new Error(`GitHub installation token request failed (${response.status})`);
  const data = await response.json<GitHubInstallationTokenResponse>();
  if (!data.token) throw new Error("GitHub installation token response did not include a token");
  return data.token;
}

async function githubAppJwt(env: AcceptanceIntegrationEnv): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are not configured");
  }
  const privateKey = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  const key = await importPKCS8(privateKey, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(key);
}

async function githubFetch(
  env: AcceptanceIntegrationEnv,
  path: string,
  input: { method: string; token: string; body?: unknown },
): Promise<Response> {
  const api = env.GITHUB_API_URL?.replace(/\/$/, "") || "https://api.github.com";
  return fetch(`${api}${path}`, {
    method: input.method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      "user-agent": "nib-acceptance-worker",
      "x-github-api-version": "2022-11-28",
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

export async function verifyGitHubOidcToken(token: string, env: AcceptanceIntegrationEnv): Promise<GitHubOidcClaims> {
  const jwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: env.ACCEPTANCE_GITHUB_OIDC_AUDIENCE || DEFAULT_OIDC_AUDIENCE,
  });
  return payload as GitHubOidcClaims;
}

function checkRunBody(event: AcceptanceChangedEvent, state: string): Record<string, unknown> {
  const completed = state !== "pending";
  const conclusion = checkConclusion(state);
  const summary = state === "approved"
    ? `Acceptance gate ${event.gate} is approved for revision ${event.revision}.`
    : state === "cloudflare_current_version_unverified"
      ? `Acceptance gate ${event.gate} needs a fresh Cloudflare version verification for revision ${event.revision}.`
      : `Acceptance gate ${event.gate} is ${state} for revision ${event.revision}.`;
  return {
    name: `${CHECK_NAME_PREFIX} / ${event.gate}`,
    head_sha: event.manifest.build.commit,
    status: completed ? "completed" : "in_progress",
    conclusion,
    details_url: `${eventOrigin(event)}/acceptance/projects/${encodeURIComponent(event.projectId)}/reviews/${encodeURIComponent(event.reviewId)}`,
    external_id: `${event.reviewId}:${event.revision}:${event.manifestHash}`,
    output: {
      title: event.manifest.title,
      summary,
      text: state === "cloudflare_current_version_unverified"
        ? `Manifest hash: ${event.manifestHash}\nReason: cloudflare_current_version_unverified`
        : `Manifest hash: ${event.manifestHash}`,
    },
  };
}

function checkConclusion(state: string): string | undefined {
  if (state === "pending") return undefined;
  if (state === "approved") return "success";
  if (state === "revision_requested" || state === "cloudflare_current_version_unverified") return "action_required";
  return "failure";
}

function eventOrigin(event: AcceptanceChangedEvent): string {
  try {
    return new URL(event.manifest.build.previewUrl).origin;
  } catch {
    return "https://nibtool.com";
  }
}

function gateEnabled(config: GitHubInstallationConfig, gate: string): boolean {
  const gates = config.gates_json ? parseJsonArray(config.gates_json) : [];
  return gates.length === 0 || gates.includes(gate);
}

function workflowAllowed(config: Pick<GitHubInstallationConfig, "allowed_workflows_json">, workflowRef: string, jobWorkflowRef: string | null): boolean {
  const allowed = parseJsonArray(config.allowed_workflows_json);
  return allowed.includes(workflowRef) || Boolean(jobWorkflowRef && allowed.includes(jobWorkflowRef));
}

function installationResponse(row: Partial<GitHubInstallationConfig> | Record<string, unknown> | null): Record<string, unknown> {
  return {
    id: row?.id,
    installationId: row?.installation_id,
    repository: {
      id: row?.repository_id,
      owner: row?.repository_owner,
      name: row?.repository_name,
    },
    allowedWorkflows: parseJsonArray(String(row?.allowed_workflows_json ?? "[]")),
    gates: row?.gates_json ? parseJsonArray(String(row.gates_json)) : [],
    enabled: row?.enabled === 1 || row?.enabled === true,
    createdAt: row?.created_at,
    updatedAt: row?.updated_at,
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function splitRepository(repository: string): [string, string] {
  const [owner = "", name = ""] = repository.split("/");
  return [owner, name];
}

function isGitHubWorkflowActor(actor: AutomationActor | null | undefined): actor is GitHubWorkflowActor {
  return Boolean(actor && "provider" in actor && actor.provider === "github");
}

function numberForSubject(subject: string): string {
  return subject.split("/").at(-1) ?? "unknown";
}

async function claimGitHubDelivery(
  id: string,
  env: AcceptanceIntegrationEnv,
): Promise<GitHubWebhookDeliveryClaim | "replayed" | "busy"> {
  const claimed = await env.DB.prepare(
    `UPDATE acceptance_github_webhook_deliveries
        SET state = 'processing',
            processing_started_at = unixepoch()
      WHERE id = ?
        AND (
          state IN ('received', 'failed')
          OR (state = 'processing' AND COALESCE(processing_started_at, received_at, 0) <= unixepoch() - ?)
        )`,
  ).bind(id, GITHUB_WEBHOOK_LEASE_TIMEOUT_SECONDS).run();

  const row = await env.DB.prepare(
    `SELECT event_name, payload_json, state
       FROM acceptance_github_webhook_deliveries
      WHERE id = ?`,
  ).bind(id).first<{ event_name: string; payload_json: string; state: string }>();

  if (!row) return "busy";
  if (claimed.meta.changes) return { eventName: row.event_name, payload: row.payload_json };
  if (row.state === "processed" || row.state === "invalid_json") return "replayed";
  return "busy";
}

async function markGitHubDelivery(id: string, env: AcceptanceIntegrationEnv, state: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE acceptance_github_webhook_deliveries
        SET state = ?,
            processed_at = unixepoch(),
            processing_started_at = NULL
      WHERE id = ?`,
  ).bind(state, id).run();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function base64UrlRandom(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
