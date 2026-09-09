import type { AcceptanceEvent, AcceptanceManifest } from "./contracts";
import { AcceptanceHttpError, readBoundedBody } from "./http";
import type { AcceptanceCoordinator } from "./coordinator";
import { getProjectAccess, getProjectSettings, type AutomationActor } from "./teams";

export interface AcceptanceIntegrationEnv {
  DB: D1Database;
  PUBLIC_ORIGIN: string;
  ACCEPTANCE_ENABLED?: string;
  ACCEPTANCE?: DurableObjectNamespace<AcceptanceCoordinator>;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_API_URL?: string;
  ACCEPTANCE_GITHUB_OIDC_AUDIENCE?: string;
}

export interface AcceptanceAccount {
  id: string;
  email?: string;
}

export type { AcceptanceManifest, AutomationActor };

export type AcceptanceChangedEvent = AcceptanceEvent;

export interface CurrentAcceptanceState {
  id?: string;
  reviewId?: string;
  revision?: number;
  manifestHash?: string;
  state?: string;
  manifest?: AcceptanceManifest;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function jsonError(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}

export function acceptanceEnabled(env: AcceptanceIntegrationEnv): boolean {
  return env.ACCEPTANCE_ENABLED === undefined || env.ACCEPTANCE_ENABLED === "true";
}

export async function readJsonObject(request: Request, limit = 1024 * 1024): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await readBoundedBody(request, limit);
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch (error) {
    if (error instanceof AcceptanceHttpError) throw error;
    return null;
  }
}

export async function readBoundedText(request: Request, limit: number): Promise<string> {
  const bytes = await readBoundedBody(request, limit);
  return new TextDecoder().decode(bytes);
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function integerString(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[1-9]\d{0,19}$/.test(trimmed) ? trimmed : null;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) values.push(item.trim());
  }
  return Array.from(new Set(values));
}

export function requireIdempotencyKey(request: Request): string | Response {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("idempotency_key_required", "POST, PUT, PATCH, and DELETE require Idempotency-Key.", 400);
  if (key.length > 200) return jsonError("idempotency_key_invalid", "Idempotency-Key is too long.", 400);
  return key;
}

export async function ensureProjectAdmin(
  db: D1Database,
  projectId: string,
  account: AcceptanceAccount | null,
): Promise<boolean> {
  if (!account?.id) return false;
  const access = await getProjectAccess(db, projectId, account.id);
  return Boolean(access?.permissions.manage);
}


export interface AtomicIdempotencyResult<T> {
  result: T;
  replayed: boolean;
}

export async function withAtomicIdempotency<T>(
  db: D1Database,
  projectId: string,
  route: string,
  idempotencyKey: string,
  requestFingerprint: string,
  response: T,
  mutations: D1PreparedStatement[],
): Promise<AtomicIdempotencyResult<T>> {
  const responseJson = JSON.stringify(response);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO acceptance_integration_idempotency(
           project_id, route, idempotency_key, request_fingerprint, state, response_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'done', ?, unixepoch(), unixepoch())`,
      ).bind(projectId, route, idempotencyKey, requestFingerprint, responseJson),
      ...mutations,
    ]);
    return { result: response, replayed: false };
  } catch (error) {
    const existing = await db.prepare(
      `SELECT request_fingerprint, state, response_json
         FROM acceptance_integration_idempotency
        WHERE project_id = ? AND route = ? AND idempotency_key = ?`,
    ).bind(projectId, route, idempotencyKey).first<{
      request_fingerprint: string;
      state: string;
      response_json: string | null;
    }>();
    if (!existing) throw error;
    if (existing.request_fingerprint !== requestFingerprint) {
      throw new Error("Integration idempotency key was reused with a different request");
    }
    if (existing.state === "done" && existing.response_json) {
      return { result: JSON.parse(existing.response_json) as T, replayed: true };
    }
    throw error;
  }
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

export async function verifyHmacSha256(secret: string, payload: string, signature: string, prefix = ""): Promise<boolean> {
  const expected = `${prefix}${await hmacSha256Hex(secret, payload)}`;
  return constantTimeEqual(expected, signature);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

export function acceptanceCoordinator(
  env: AcceptanceIntegrationEnv,
  projectId: string,
): DurableObjectStub<AcceptanceCoordinator> | null {
  if (!env.ACCEPTANCE) return null;
  return env.ACCEPTANCE.get(env.ACCEPTANCE.idFromName(`project:${projectId}`));
}

export async function fetchCurrentAcceptanceState(
  env: AcceptanceIntegrationEnv,
  event: AcceptanceChangedEvent,
): Promise<CurrentAcceptanceState | null> {
  const settings = await getProjectSettings(env.DB, event.projectId);
  if (!settings?.enabled) {
    return {
      id: event.reviewId,
      reviewId: event.reviewId,
      revision: event.revision,
      manifestHash: event.manifestHash,
      state: "project_disabled",
      manifest: event.manifest,
    };
  }

  const coordinator = acceptanceCoordinator(env, event.projectId);
  const current = await coordinator?.getCurrent(event.subject, event.gate);
  if (!current) return null;
  return {
    id: current.id,
    reviewId: current.id,
    revision: current.revision,
    manifestHash: current.manifestHash,
    state: current.state,
    manifest: current.manifest,
  };
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
