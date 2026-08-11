import type { NibPrincipal } from "./account";
import type { Env } from "./types";

export const expertTokenScopes = [
  "generate:read",
  "generate:write",
  "reviews:read",
  "reviews:write",
] as const;

export type ExpertTokenScope = (typeof expertTokenScopes)[number];

export interface ExpertTokenPrincipal extends NibPrincipal {
  expertToken: {
    id: string;
    scopes: ExpertTokenScope[];
  };
}

export interface ExpertTokenSummary {
  id: string;
  name: string;
  scopes: ExpertTokenScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

interface NormalizedExpertTokenRequest {
  name: string;
  scopes: ExpertTokenScope[];
  expiresInDays: number;
}

const tokenPattern = /^nib_pat_([0-9a-f]{32})_([A-Za-z0-9_-]{8,})$/;
const encoder = new TextEncoder();

export function parseExpertToken(value: string): { id: string; token: string } | undefined {
  const match = tokenPattern.exec(value);
  if (!match) return undefined;
  return { id: match[1]!, token: value };
}

export function normalizeExpertTokenRequest(value: unknown): NormalizedExpertTokenRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid token request");
  const input = value as { name?: unknown; scopes?: unknown; expiresInDays?: unknown };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) throw new Error("Token name must be between 1 and 80 characters");
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    throw new Error("Select at least one token scope");
  }
  const scopes = [...new Set(input.scopes.map((scope) => String(scope)))];
  for (const scope of scopes) {
    if (!(expertTokenScopes as readonly string[]).includes(scope)) {
      throw new Error(`Unsupported token scope: ${scope}`);
    }
  }
  const expiresInDays = input.expiresInDays === undefined ? 90 : Number(input.expiresInDays);
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    throw new Error("Token expiry must be between 1 and 365 days");
  }
  return {
    name,
    scopes: (expertTokenScopes as readonly ExpertTokenScope[]).filter((scope) => scopes.includes(scope)),
    expiresInDays,
  };
}

export async function issueExpertToken(
  env: Pick<Env, "DB">,
  principal: NibPrincipal,
  request: unknown,
): Promise<ExpertTokenSummary & { token: string }> {
  const normalized = normalizeExpertTokenRequest(request);
  const id = randomHex(16);
  const token = `nib_pat_${id}_${randomBase64Url(32)}`;
  const tokenHash = await sha256(token);
  const createdAt = Math.floor(Date.now() / 1000);
  const expiresAt = createdAt + normalized.expiresInDays * 24 * 60 * 60;
  await env.DB.prepare(
    "INSERT INTO expert_tokens(id, token_hash, user_id, workspace_id, name, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      tokenHash,
      principal.userId,
      principal.workspaceId,
      normalized.name,
      JSON.stringify(normalized.scopes),
      createdAt,
      expiresAt,
    )
    .run();
  return {
    id,
    token,
    name: normalized.name,
    scopes: normalized.scopes,
    createdAt,
    expiresAt,
    lastUsedAt: null,
  };
}

export async function listExpertTokens(
  env: Pick<Env, "DB">,
  principal: NibPrincipal,
): Promise<ExpertTokenSummary[]> {
  const result = await env.DB.prepare(
    "SELECT id, name, scopes, created_at, expires_at, last_used_at FROM expert_tokens WHERE user_id = ? AND workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
  )
    .bind(principal.userId, principal.workspaceId)
    .all<{
      id: string;
      name: string;
      scopes: string;
      created_at: number;
      expires_at: number;
      last_used_at: number | null;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    name: row.name,
    scopes: parseStoredScopes(row.scopes),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function revokeExpertToken(
  env: Pick<Env, "DB">,
  principal: NibPrincipal,
  id: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE expert_tokens SET revoked_at = unixepoch() WHERE id = ? AND user_id = ? AND workspace_id = ? AND revoked_at IS NULL",
  )
    .bind(id, principal.userId, principal.workspaceId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function authenticateExpertToken(
  request: Request,
  env: Pick<Env, "DB">,
): Promise<ExpertTokenPrincipal | undefined> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const parsed = parseExpertToken(authorization.slice("Bearer ".length).trim());
  if (!parsed) return undefined;
  const row = await env.DB.prepare(
    "SELECT t.token_hash, t.user_id, t.workspace_id, t.scopes, p.email, m.role FROM expert_tokens t JOIN user_profiles p ON p.id = t.user_id JOIN workspace_members m ON m.user_id = t.user_id AND m.workspace_id = t.workspace_id WHERE t.id = ? AND t.revoked_at IS NULL AND t.expires_at > unixepoch()",
  )
    .bind(parsed.id)
    .first<{
      token_hash: string;
      user_id: string;
      workspace_id: string;
      scopes: string;
      email: string;
      role: NibPrincipal["role"];
    }>();
  if (!row || !constantTimeEqual(row.token_hash, await sha256(parsed.token))) return undefined;
  await env.DB.prepare("UPDATE expert_tokens SET last_used_at = unixepoch() WHERE id = ?")
    .bind(parsed.id)
    .run();
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    expertToken: { id: parsed.id, scopes: parseStoredScopes(row.scopes) },
  };
}

export function requiredExpertScope(request: Request): ExpertTokenScope {
  const pathname = new URL(request.url).pathname;
  const read = request.method === "GET" || request.method === "HEAD";
  if (pathname.startsWith("/artifacts/")) return "generate:read";
  if (pathname.startsWith("/v1/")) return read ? "generate:read" : "generate:write";
  return read ? "reviews:read" : "reviews:write";
}

export function hasRequiredExpertScope(
  scopes: readonly ExpertTokenScope[],
  required: ExpertTokenScope,
): boolean {
  return scopes.includes(required);
}

function parseStoredScopes(value: string): ExpertTokenScope[] {
  try {
    const scopes: unknown = JSON.parse(value);
    if (!Array.isArray(scopes)) return [];
    return expertTokenScopes.filter((scope) => scopes.includes(scope));
  } catch {
    return [];
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomBase64Url(bytes: number): string {
  const binary = String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
