import {
  type AcceptanceAccount,
  type AcceptanceChangedEvent,
  type AcceptanceIntegrationEnv,
  acceptanceEnabled,
  ensureProjectAdmin,
  hmacSha256Hex,
  json,
  jsonError,
  readJsonObject,
  requireIdempotencyKey,
  sha256Hex,
  stringArray,
  stringValue,
  withAtomicIdempotency,
} from "./common";
import { acceptancePilotEnabled, isPilotAccountAllowed, isPilotProjectAllowed, pilotIds } from "./pilot";

interface WebhookEndpointRow {
  id: string;
  project_id: string;
  url: string;
  description: string | null;
  secret: string;
  events_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  project_id: string;
  event_id: string;
  project_sequence: number;
  payload_json: string;
}

const API_PREFIX = "/api/acceptance/v1";

export async function handleCustomerWebhookRoutes(
  request: Request,
  env: AcceptanceIntegrationEnv,
  account: AcceptanceAccount | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/api\/acceptance\/v1\/projects\/([^/]+)\/integrations\/webhooks(?:\/([^/]+)(?:\/deliveries\/([^/]+)\/replay)?)?$/,
  );
  if (!match) return null;
  const projectId = decodeURIComponent(match[1] ?? "");
  const webhookId = match[2] ? decodeURIComponent(match[2]) : null;
  const deliveryId = match[3] ? decodeURIComponent(match[3]) : null;
  if (!projectId) return jsonError("not_found", "Project not found.", 404);
  if (!acceptanceEnabled(env)) return jsonError("acceptance_disabled", "Acceptance is disabled.", 403);
  if (!isPilotProjectAllowed(env, projectId) || (account && !isPilotAccountAllowed(env, account.id))) return jsonError("pilot_required", "This project or account is not enabled for the acceptance pilot.", 403);
  if (!(await ensureProjectAdmin(env.DB, projectId, account))) {
    return jsonError("forbidden", "Project admin access is required.", 403);
  }

  if (!webhookId && request.method === "GET") return listWebhookEndpoints(projectId, env);
  if (!webhookId && request.method === "POST") return createWebhookEndpoint(request, env, projectId, account);
  if (webhookId && !deliveryId && request.method === "PATCH") return updateWebhookEndpoint(request, env, projectId, webhookId);
  if (webhookId && !deliveryId && request.method === "DELETE") return deleteWebhookEndpoint(request, env, projectId, webhookId);
  if (webhookId && deliveryId && request.method === "POST") return manualReplayWebhookDelivery(request, env, projectId, webhookId, deliveryId);
  return jsonError("method_not_allowed", "Method not allowed.", 405);
}

export async function enqueueCustomerWebhooksForAcceptanceEvent(
  event: AcceptanceChangedEvent,
  env: AcceptanceIntegrationEnv,
): Promise<void> {
  if (!isPilotProjectAllowed(env, event.projectId)) return;
  const endpoints = await env.DB.prepare(
    `SELECT *
       FROM acceptance_webhook_endpoints
      WHERE project_id = ? AND enabled = 1`,
  ).bind(event.projectId).all<WebhookEndpointRow>();
  for (const endpoint of endpoints.results) {
    if (!subscribed(endpoint, event.type)) continue;
    await enqueueWebhookDelivery(endpoint, event, env);
  }
  await deliverQueuedCustomerWebhooks(env, event.projectId);
}

export async function deliverQueuedCustomerWebhooks(
  env: AcceptanceIntegrationEnv,
  projectId?: string,
  limit = 25,
): Promise<void> {
  const query = projectId
    ? env.DB.prepare(
        `SELECT d.*
           FROM acceptance_webhook_deliveries d
          WHERE d.project_id = ?
            AND d.state IN ('queued', 'retry')
            AND d.next_attempt_at <= unixepoch()
            AND (? = 0 OR d.project_id IN (SELECT value FROM json_each(?)))
          ORDER BY d.project_id, d.project_sequence
          LIMIT ?`,
      ).bind(projectId, acceptancePilotEnabled(env) ? 1 : 0, JSON.stringify(pilotIds(env.ACCEPTANCE_PILOT_PROJECT_IDS)), limit)
    : env.DB.prepare(
        `SELECT d.*
           FROM acceptance_webhook_deliveries d
          WHERE d.state IN ('queued', 'retry')
            AND d.next_attempt_at <= unixepoch()
            AND (? = 0 OR d.project_id IN (SELECT value FROM json_each(?)))
          ORDER BY d.project_id, d.project_sequence
          LIMIT ?`,
      ).bind(acceptancePilotEnabled(env) ? 1 : 0, JSON.stringify(pilotIds(env.ACCEPTANCE_PILOT_PROJECT_IDS)), limit);
  const deliveries = await query.all<WebhookDeliveryRow>();
  for (const delivery of deliveries.results) {
    if (!isPilotProjectAllowed(env, delivery.project_id)) continue;
    await deliverWebhookDelivery(delivery, env);
  }
}

async function listWebhookEndpoints(projectId: string, env: AcceptanceIntegrationEnv): Promise<Response> {
  const endpoints = await env.DB.prepare(
    `SELECT id, project_id, url, description, events_json, enabled, created_at, updated_at
       FROM acceptance_webhook_endpoints
      WHERE project_id = ?
      ORDER BY created_at`,
  ).bind(projectId).all<Omit<WebhookEndpointRow, "secret">>();
  const deliveries = await env.DB.prepare(
    `SELECT id, webhook_id, event_id, project_sequence, state, attempt_count, last_status, next_attempt_at, created_at
       FROM acceptance_webhook_deliveries
      WHERE project_id = ?
      ORDER BY project_sequence DESC
      LIMIT 100`,
  ).bind(projectId).all<Record<string, unknown>>();
  return json({
    webhooks: endpoints.results.map(endpointResponse),
    deliveries: deliveries.results,
  });
}

async function createWebhookEndpoint(
  request: Request,
  env: AcceptanceIntegrationEnv,
  projectId: string,
  account: AcceptanceAccount | null,
): Promise<Response> {
  const key = requireIdempotencyKey(request);
  if (key instanceof Response) return key;
  const input = await readJsonObject(request);
  if (!input) return jsonError("invalid_json", "JSON object body is required.", 400);
  const targetUrl = await validateWebhookUrl(input.url);
  if (!targetUrl) return jsonError("invalid_webhook_url", "Webhook URL must be a public HTTPS endpoint without redirects.", 400);
  const events = stringArray(input.events).length ? stringArray(input.events) : ["acceptance.changed"];
  const description = stringValue(input.description);
  const secret = `whsec_${base64UrlRandom(32)}`;
  const id = crypto.randomUUID();
  const response = {
    webhook: {
      id,
      projectId,
      url: targetUrl,
      description,
      events,
      enabled: true,
      signingSecret: secret,
    },
  };
  const mutation = env.DB.prepare(
    `INSERT INTO acceptance_webhook_endpoints(
       id, project_id, url, description, secret, events_json, enabled, created_by_account_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch())`,
  ).bind(id, projectId, targetUrl, description, secret, JSON.stringify(events), account?.id ?? null);
  const stored = await withAtomicIdempotency(
    env.DB,
    projectId,
    "webhooks.create",
    key,
    await requestFingerprint({ targetUrl, events, description }),
    response,
    [mutation],
  );
  return json(stored.result, 201);
}

async function updateWebhookEndpoint(
  request: Request,
  env: AcceptanceIntegrationEnv,
  projectId: string,
  webhookId: string,
): Promise<Response> {
  const key = requireIdempotencyKey(request);
  if (key instanceof Response) return key;
  const input = await readJsonObject(request);
  if (!input) return jsonError("invalid_json", "JSON object body is required.", 400);
  const current = await env.DB.prepare(
    "SELECT * FROM acceptance_webhook_endpoints WHERE project_id = ? AND id = ?",
  ).bind(projectId, webhookId).first<WebhookEndpointRow>();
  if (!current) return jsonError("not_found", "Webhook endpoint not found.", 404);
  const targetUrl = input.url === undefined ? current.url : await validateWebhookUrl(input.url);
  if (!targetUrl) return jsonError("invalid_webhook_url", "Webhook URL must be a public HTTPS endpoint without redirects.", 400);
  const events = input.events === undefined ? parseJsonArray(current.events_json) : stringArray(input.events);
  if (events.length === 0) return jsonError("events_required", "At least one event is required.", 400);
  const description = input.description === undefined ? current.description : stringValue(input.description);
  const enabled = input.enabled === undefined ? current.enabled === 1 : input.enabled === true;
  const response = {
    webhook: endpointResponse({
      ...current,
      url: targetUrl,
      description,
      events_json: JSON.stringify(events),
      enabled: enabled ? 1 : 0,
    }),
  };
  const mutation = env.DB.prepare(
    `UPDATE acceptance_webhook_endpoints
        SET url = ?, description = ?, events_json = ?, enabled = ?, updated_at = unixepoch()
      WHERE project_id = ? AND id = ?`,
  ).bind(targetUrl, description, JSON.stringify(events), enabled ? 1 : 0, projectId, webhookId);
  const stored = await withAtomicIdempotency(
    env.DB,
    projectId,
    "webhooks.update",
    key,
    await requestFingerprint({ webhookId, targetUrl, events, description, enabled }),
    response,
    [mutation],
  );
  return json(stored.result);
}

async function deleteWebhookEndpoint(
  request: Request,
  env: AcceptanceIntegrationEnv,
  projectId: string,
  webhookId: string,
): Promise<Response> {
  const key = requireIdempotencyKey(request);
  if (key instanceof Response) return key;
  const mutation = env.DB.prepare(
    "UPDATE acceptance_webhook_endpoints SET enabled = 0, updated_at = unixepoch() WHERE project_id = ? AND id = ?",
  ).bind(projectId, webhookId);
  const stored = await withAtomicIdempotency(
    env.DB,
    projectId,
    "webhooks.delete",
    key,
    await requestFingerprint({ webhookId }),
    { ok: true },
    [mutation],
  );
  return json(stored.result);
}

async function manualReplayWebhookDelivery(
  request: Request,
  env: AcceptanceIntegrationEnv,
  projectId: string,
  webhookId: string,
  deliveryId: string,
): Promise<Response> {
  const key = requireIdempotencyKey(request);
  if (key instanceof Response) return key;
  const delivery = await env.DB.prepare(
    `SELECT *
       FROM acceptance_webhook_deliveries
      WHERE project_id = ? AND webhook_id = ? AND id = ?`,
  ).bind(projectId, webhookId, deliveryId).first<WebhookDeliveryRow>();
  const response = delivery ? { ok: true, deliveryId } : { error: { code: "not_found", message: "Webhook delivery not found." } };
  const mutations = delivery
    ? [env.DB.prepare(
        `UPDATE acceptance_webhook_deliveries
            SET state = 'queued', next_attempt_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ?`,
      ).bind(deliveryId)]
    : [];
  const stored = await withAtomicIdempotency(
    env.DB,
    projectId,
    "webhooks.delivery.replay",
    key,
    await requestFingerprint({ webhookId, deliveryId }),
    response,
    mutations,
  );
  if ("error" in stored.result) return json(stored.result, 404);
  if (delivery && !stored.replayed) await deliverWebhookDelivery(delivery, env);
  return json(stored.result);
}

async function enqueueWebhookDelivery(
  endpoint: WebhookEndpointRow,
  event: AcceptanceChangedEvent,
  env: AcceptanceIntegrationEnv,
): Promise<void> {
  const sequence = await nextProjectSequence(event.projectId, env);
  const payload = {
    event: event.type,
    id: event.id,
    projectId: event.projectId,
    reviewId: event.reviewId,
    subject: event.subject,
    gate: event.gate,
    revision: event.revision,
    sequence: event.sequence,
    projectSequence: sequence,
    state: event.state,
    manifestHash: event.manifestHash,
    occurredAt: event.occurredAt,
    receipt: event.receipt,
  };
  await env.DB.prepare(
    `INSERT OR IGNORE INTO acceptance_webhook_deliveries(
       id, webhook_id, project_id, event_id, project_sequence, payload_json, state, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'queued', unixepoch(), unixepoch(), unixepoch())`,
  ).bind(crypto.randomUUID(), endpoint.id, event.projectId, event.id, sequence, JSON.stringify(payload)).run();
}

async function deliverWebhookDelivery(delivery: WebhookDeliveryRow, env: AcceptanceIntegrationEnv): Promise<void> {
  const endpoint = await env.DB.prepare(
    "SELECT * FROM acceptance_webhook_endpoints WHERE id = ? AND project_id = ? AND enabled = 1",
  ).bind(delivery.webhook_id, delivery.project_id).first<WebhookEndpointRow>();
  if (!endpoint) return;
  const stillPublic = await validateWebhookUrl(endpoint.url);
  if (!stillPublic) {
    await recordWebhookAttempt(delivery, env, 0, "retry", "Webhook URL is no longer a public HTTPS endpoint without redirects.");
    return;
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${delivery.payload_json}`;
  const signature = await hmacSha256Hex(endpoint.secret, signedPayload);
  let status = 0;
  let state = "retry";
  let responseText = "";
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "user-agent": "nib-acceptance-webhook",
        "x-nib-event": "acceptance.changed",
        "x-nib-delivery": delivery.id,
        "x-nib-project": delivery.project_id,
        "x-nib-sequence": String(delivery.project_sequence),
        "x-nib-signature": `t=${timestamp},v1=${signature}`,
      },
      body: delivery.payload_json,
    });
    status = response.status;
    responseText = (await response.text()).slice(0, 2048);
    state = response.ok ? "delivered" : "retry";
  } catch (error) {
    responseText = error instanceof Error ? error.message : "unknown delivery error";
  }

  await recordWebhookAttempt(delivery, env, status, state, responseText);
}

async function recordWebhookAttempt(
  delivery: WebhookDeliveryRow,
  env: AcceptanceIntegrationEnv,
  status: number,
  state: string,
  responseText: string,
): Promise<void> {
  const attempt = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM acceptance_webhook_attempts WHERE delivery_id = ?",
  ).bind(delivery.id).first<{ count: number }>();
  const attemptNumber = (attempt?.count ?? 0) + 1;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO acceptance_webhook_attempts(
         id, delivery_id, attempt_number, status, response_body, attempted_at
       ) VALUES (?, ?, ?, ?, ?, unixepoch())`,
    ).bind(crypto.randomUUID(), delivery.id, attemptNumber, status, responseText),
    env.DB.prepare(
      `UPDATE acceptance_webhook_deliveries
          SET state = ?,
              attempt_count = ?,
              last_status = ?,
              next_attempt_at = CASE WHEN ? = 'delivered' THEN NULL ELSE unixepoch() + ? END,
              updated_at = unixepoch()
        WHERE id = ?`,
    ).bind(state, attemptNumber, status, state, retryDelaySeconds(attemptNumber), delivery.id),
  ]);
}

async function nextProjectSequence(projectId: string, env: AcceptanceIntegrationEnv): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO acceptance_webhook_project_sequences(project_id, next_sequence, updated_at)
     VALUES (?, 1, unixepoch())
     ON CONFLICT(project_id) DO UPDATE SET
       next_sequence = next_sequence + 1,
       updated_at = unixepoch()`,
  ).bind(projectId).run();
  const row = await env.DB.prepare(
    "SELECT next_sequence FROM acceptance_webhook_project_sequences WHERE project_id = ?",
  ).bind(projectId).first<{ next_sequence: number }>();
  return row?.next_sequence ?? 1;
}

function endpointResponse(row: Partial<WebhookEndpointRow>): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    url: row.url,
    description: row.description,
    events: parseJsonArray(row.events_json ?? "[]"),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function subscribed(endpoint: WebhookEndpointRow, eventName: string): boolean {
  const events = parseJsonArray(endpoint.events_json);
  return events.includes(eventName);
}

async function validateWebhookUrl(value: unknown): Promise<string | null> {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (isForbiddenHost(url.hostname)) return null;
    if (!(await resolvesToPublicAddress(url.hostname))) return null;
    const probe = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (probe.status >= 300 && probe.status < 400) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  if (isIpAddress(hostname)) return !isForbiddenHost(hostname);
  const answers = await Promise.all([
    resolveDns(hostname, "A"),
    resolveDns(hostname, "AAAA"),
  ]);
  const addresses = answers.flat();
  return addresses.length > 0 && addresses.every((address) => !isForbiddenHost(address));
}

async function resolveDns(hostname: string, type: "A" | "AAAA"): Promise<string[]> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return [];
  const body: { Answer?: { data?: unknown }[] } = await response.json<{ Answer?: { data?: unknown }[] }>().catch(() => ({}));
  return (body.Answer ?? [])
    .map((answer: { data?: unknown }) => answer.data)
    .filter((data: unknown): data is string => typeof data === "string");
}

function isForbiddenHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  if (isPrivateIpv4(normalized)) return true;
  if (isPrivateIpv6(normalized)) return true;
  return false;
}

function isIpAddress(value: string): boolean {
  return isIpv4(value) || /^\[?[0-9a-f:]+\]?$/i.test(value);
}

function isIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 0;
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized === "::";
}

async function requestFingerprint(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value));
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function retryDelaySeconds(attemptNumber: number): number {
  return Math.min(3600, 2 ** Math.min(attemptNumber, 10) * 30);
}

function base64UrlRandom(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
