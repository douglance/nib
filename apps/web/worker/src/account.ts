import type { Env } from "./types";

export const sessionLifetimeSeconds = 60 * 60 * 24 * 30;

export interface NibPrincipal {
  userId: string;
  workspaceId: string;
  email: string;
  role: "owner" | "admin" | "member";
}

export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function personalWorkspaceName(email: string): string {
  const local = canonicalEmail(email).split("@", 1)[0] ?? "";
  const readable = local.replace(/[^a-z0-9]+/gi, " ").trim();
  if (!readable) return "My Nib";
  return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}'s Nib`;
}

export async function provisionPersonalWorkspace(
  env: Pick<Env, "DB">,
  authUser: { id: string; email: string; name?: string | null },
): Promise<NibPrincipal> {
  const email = canonicalEmail(authUser.email);
  const userId = `usr_${authUser.id}`;
  const workspaceId = `wsp_${authUser.id}`;
  const displayName = authUser.name?.trim() || email.split("@", 1)[0] || "Nib user";

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO user_profiles(id, auth_user_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())",
    ).bind(userId, authUser.id, email, displayName),
    env.DB.prepare(
      "INSERT OR IGNORE INTO workspaces(id, name, kind, created_by_user_id, created_at, updated_at) VALUES (?, ?, 'personal', ?, unixepoch(), unixepoch())",
    ).bind(workspaceId, personalWorkspaceName(email), userId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO workspace_members(workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', unixepoch())",
    ).bind(workspaceId, userId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO accounts(tenant_id, plan, created_at, updated_at) VALUES (?, 'default', unixepoch(), unixepoch())",
    ).bind(workspaceId),
  ]);

  return { userId, workspaceId, email, role: "owner" };
}

export async function principalForAuthUser(
  env: Pick<Env, "DB">,
  authUserId: string,
): Promise<NibPrincipal | undefined> {
  const row = await env.DB.prepare(
    "SELECT p.id AS user_id, p.email, m.workspace_id, m.role FROM user_profiles p JOIN workspace_members m ON m.user_id = p.id WHERE p.auth_user_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at LIMIT 1",
  )
    .bind(authUserId)
    .first<{ user_id: string; email: string; workspace_id: string; role: NibPrincipal["role"] }>();
  if (!row) return undefined;
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
  };
}
