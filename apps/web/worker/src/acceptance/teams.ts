import { normalizeEmail, type NibAccount } from "../account-auth";
import type { Env } from "../types";
import { AcceptanceHttpError, acceptanceErrorResponse } from "./http";
import { acceptancePilotEnabled, assertPilotAccount, assertPilotProject, isPilotEmailAllowed, isPilotProjectAllowed, pilotIds, type AcceptancePilotEnv } from "./pilot";

const API_PREFIX = "/api/acceptance/v1";
const DEFAULT_QUORUM = 1;
const DEFAULT_TTL_SECONDS = 604800;
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const INVITATION_EMAIL_LEASE_SECONDS = 120;
const CREDENTIAL_PREFIX = "nib_acceptance";
const SENDER = "login@nibtool.com";

type TeamRole = "owner" | "admin" | "member";
type InviteRole = "admin" | "member";
type ProjectRole = "admin" | "reviewer" | "viewer";
type CredentialScope = "publish" | "read" | "verify";

export interface ProjectAccess {
  projectId: string;
  teamId: string;
  role: ProjectRole;
  permissions: {
    read: boolean;
    publish: boolean;
    review: boolean;
    manage: boolean;
  };
  policy: {
    quorum: number;
    ttlSeconds: number;
  };
  publicRead: boolean;
  enabled: boolean;
}

export interface AutomationActor {
  id: string;
  projectId: string;
  scopes: string[];
}

export interface ProjectSettings {
  id: string;
  teamId: string;
  quorum: number;
  ttlSeconds: number;
  publicRead: boolean;
  enabled: boolean;
}

export interface ArchivedTeam {
  teamId: string;
  projectIds: string[];
}

interface TeamRow {
  id: string;
  name: string;
  default_quorum: number;
  default_ttl_seconds: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  archived_by: string | null;
}

interface ProjectRow {
  id: string;
  team_id: string;
  name: string;
  slug: string | null;
  quorum: number;
  ttl_seconds: number;
  public_read: number;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  archived_by: string | null;
}

interface MemberRow {
  account_id: string;
  email: string | null;
  role: string;
  added_at: number;
}

interface InvitationRow {
  id: string;
  team_id: string;
  email: string;
  role: InviteRole;
  created_by: string;
  created_at: number;
  expires_at: number;
  last_sent_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

interface CredentialRow {
  id: string;
  project_id: string;
  name: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface IdempotencyContext {
  accountId: string;
  key: string;
  requestHash: string;
}

interface PlannedMutation {
  status: number;
  body: Record<string, unknown>;
  statements: D1PreparedStatement[];
}

interface InvitationEmailRow {
  id: string;
  email: string;
  raw_message: string;
}

export async function handleTeamRoutes(
  request: Request,
  env: Env,
  account: NibAccount,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(API_PREFIX)) return null;
  const relativePath = url.pathname.slice(API_PREFIX.length) || "/";
  const parts = relativePath.split("/").filter(Boolean).map((part) => decodeURIComponent(part));

  try {
    assertPilotAccount(env, account.id);
    if (parts[0] === "projects" && parts[1]) assertPilotProject(env, parts[1]);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return await withIdempotency(request, env, account.id, async (input, idempotency) =>
        routeMutation(request, env, account, parts, input, idempotency),
      );
    }
    return await routeRead(request, env, account, parts);
  } catch (error) {
    if (error instanceof AcceptanceHttpError) return acceptanceErrorResponse(error);
    if (error instanceof HttpError) return jsonError(error.code, error.message, error.status);
    console.error("Acceptance team route failed", error);
    return jsonError("internal_error", "Acceptance team request failed.", 500);
  }
}

export async function getProjectSettings(db: D1Database, id: string): Promise<ProjectSettings | null> {
  const row = await db.prepare(
    `SELECT p.id, p.team_id, p.quorum, p.ttl_seconds, p.public_read, p.enabled
       FROM acceptance_projects p
       JOIN acceptance_teams t ON t.id = p.team_id
      WHERE p.id = ? AND p.archived_at IS NULL AND t.archived_at IS NULL`,
  ).bind(id).first<{
    id: string;
    team_id: string;
    quorum: number;
    ttl_seconds: number;
    public_read: number;
    enabled: number;
  }>();
  return row ? {
    id: row.id,
    teamId: row.team_id,
    quorum: row.quorum,
    ttlSeconds: row.ttl_seconds,
    publicRead: row.public_read === 1,
    enabled: row.enabled === 1,
  } : null;
}

export async function getProjectAccess(
  db: D1Database,
  projectId: string,
  accountId: string,
): Promise<ProjectAccess | null> {
  const row = await db.prepare(
    `SELECT p.id, p.team_id, p.quorum, p.ttl_seconds, p.public_read, p.enabled,
            tm.role AS team_role, pm.role AS project_role
       FROM acceptance_projects p
       JOIN acceptance_teams t ON t.id = p.team_id
       LEFT JOIN acceptance_team_members tm
         ON tm.team_id = p.team_id AND tm.account_id = ?
       LEFT JOIN acceptance_project_members pm
         ON pm.project_id = p.id AND pm.account_id = ?
      WHERE p.id = ? AND p.archived_at IS NULL AND t.archived_at IS NULL`,
  ).bind(accountId, accountId, projectId).first<{
    id: string;
    team_id: string;
    quorum: number;
    ttl_seconds: number;
    public_read: number;
    enabled: number;
    team_role: TeamRole | null;
    project_role: ProjectRole | null;
  }>();
  if (!row) return null;

  let role = row.project_role;
  if (row.team_role === "owner" || row.team_role === "admin") role = "admin";
  if (!role) return null;

  return {
    projectId: row.id,
    teamId: row.team_id,
    role,
    permissions: projectPermissions(role, row.enabled === 1),
    policy: { quorum: row.quorum, ttlSeconds: row.ttl_seconds },
    publicRead: row.public_read === 1,
    enabled: row.enabled === 1,
  };
}

export async function listEligibleReviewers(db: D1Database, projectId: string): Promise<string[]> {
  const project = await getProjectSettings(db, projectId);
  if (!project?.enabled) return [];
  const rows = await allRows<{ account_id: string }>(db.prepare(
    `SELECT tm.account_id
      FROM acceptance_projects p
      JOIN acceptance_teams t ON t.id = p.team_id
      JOIN acceptance_team_members tm ON tm.team_id = p.team_id
      WHERE p.id = ? AND p.archived_at IS NULL AND t.archived_at IS NULL AND tm.role IN ('owner', 'admin')
      UNION
     SELECT pm.account_id
       FROM acceptance_project_members pm
       JOIN acceptance_projects p ON p.id = pm.project_id
       JOIN acceptance_teams t ON t.id = p.team_id
      WHERE pm.project_id = ? AND p.archived_at IS NULL AND t.archived_at IS NULL AND pm.role IN ('admin', 'reviewer')
      ORDER BY account_id`,
  ).bind(projectId, projectId));
  return rows.map((row) => row.account_id);
}

export async function listProjectRecipients(
  db: D1Database,
  projectId: string,
): Promise<{ accountId: string; email: string }[]> {
  const rows = await allRows<{ account_id: string; email: string }>(db.prepare(
    `SELECT a.account_id, a.email
      FROM acceptance_projects p
       JOIN acceptance_teams t ON t.id = p.team_id
       JOIN acceptance_team_members tm ON tm.team_id = p.team_id
       JOIN accounts a ON a.account_id = tm.account_id
      WHERE p.id = ? AND p.archived_at IS NULL AND t.archived_at IS NULL AND tm.role IN ('owner', 'admin')
      UNION
     SELECT a.account_id, a.email
       FROM acceptance_project_members pm
       JOIN acceptance_projects p ON p.id = pm.project_id
       JOIN acceptance_teams t ON t.id = p.team_id
       JOIN accounts a ON a.account_id = pm.account_id
      WHERE pm.project_id = ? AND p.archived_at IS NULL AND t.archived_at IS NULL
      ORDER BY email`,
  ).bind(projectId, projectId));
  return rows.map((row) => ({ accountId: row.account_id, email: row.email }));
}

export async function authenticateAutomation(
  db: D1Database,
  token: string,
): Promise<AutomationActor | null> {
  if (!token.startsWith(`${CREDENTIAL_PREFIX}_`)) return null;
  const tokenHash = await sha256(token);
  const row = await db.prepare(
    `SELECT c.id, c.project_id, c.scopes
       FROM acceptance_project_credentials c
       JOIN acceptance_projects p ON p.id = c.project_id
       JOIN acceptance_teams t ON t.id = p.team_id
      WHERE c.token_hash = ? AND c.revoked_at IS NULL AND p.enabled = 1
        AND p.archived_at IS NULL AND t.archived_at IS NULL`,
  ).bind(tokenHash).first<{ id: string; project_id: string; scopes: string }>();
  if (!row) return null;
  await db.prepare("UPDATE acceptance_project_credentials SET last_used_at = ? WHERE id = ?")
    .bind(unixTime(), row.id).run();
  return { id: row.id, projectId: row.project_id, scopes: parseScopes(row.scopes) };
}

export async function assertCanDeleteAccount(db: D1Database, accountId: string): Promise<void> {
  const rows = await allRows<{ team_id: string; owners: number }>(db.prepare(
    `SELECT team_id, COUNT(*) AS owners
       FROM acceptance_team_members
      WHERE role = 'owner'
        AND team_id IN (
          SELECT tm.team_id
            FROM acceptance_team_members tm
            JOIN acceptance_teams t ON t.id = tm.team_id
           WHERE tm.account_id = ? AND tm.role = 'owner' AND t.archived_at IS NULL
        )
      GROUP BY team_id`,
  ).bind(accountId));
  if (rows.some((row) => row.owners <= 1)) {
    throw new Error("acceptance_last_owner");
  }
}

export async function removeAccountMemberships(db: D1Database, accountId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM acceptance_project_members WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM acceptance_team_members WHERE account_id = ?").bind(accountId),
    db.prepare("UPDATE acceptance_team_invitations SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?) WHERE accepted_by = ? OR created_by = ?")
      .bind(unixTime(), accountId, accountId, accountId),
    db.prepare("UPDATE acceptance_project_credentials SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?) WHERE created_by = ?")
      .bind(unixTime(), accountId, accountId),
  ]);
}

async function planArchiveProject(
  db: D1Database,
  projectId: string,
  actorId: string,
): Promise<PlannedMutation | null> {
  const settings = await activeProjectSettings(db, projectId);
  if (!settings) return null;
  const now = unixTime();
  return mutation(200, { archived: true, project: settings }, [
    db.prepare(
      `UPDATE acceptance_projects
          SET enabled = 0, public_read = 0, archived_at = ?, archived_by = ?, updated_at = ?
        WHERE id = ? AND archived_at IS NULL`,
    ).bind(now, actorId, now, projectId),
    db.prepare("DELETE FROM acceptance_project_members WHERE project_id = ?").bind(projectId),
    db.prepare(
      `UPDATE acceptance_project_credentials
          SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?)
        WHERE project_id = ?`,
    ).bind(now, actorId, projectId),
  ]);
}

async function planArchiveTeam(
  db: D1Database,
  teamId: string,
  actorId: string,
): Promise<PlannedMutation | null> {
  const team = await activeTeamById(db, teamId);
  if (!team) return null;
  const projects = await allRows<{ id: string }>(db.prepare(
    "SELECT id FROM acceptance_projects WHERE team_id = ? AND archived_at IS NULL ORDER BY created_at",
  ).bind(teamId));
  const now = unixTime();
  const projectIds = projects.map((project) => project.id);
  return mutation(200, { archived: true, teamId, projectIds }, [
    db.prepare(
      `UPDATE acceptance_teams
          SET archived_at = ?, archived_by = ?, updated_at = ?
        WHERE id = ? AND archived_at IS NULL`,
    ).bind(now, actorId, now, teamId),
    db.prepare(
      `UPDATE acceptance_projects
          SET enabled = 0, public_read = 0, archived_at = COALESCE(archived_at, ?),
              archived_by = COALESCE(archived_by, ?), updated_at = ?
        WHERE team_id = ?`,
    ).bind(now, actorId, now, teamId),
    db.prepare(
      `DELETE FROM acceptance_project_members
        WHERE project_id IN (SELECT id FROM acceptance_projects WHERE team_id = ?)`,
    ).bind(teamId),
    db.prepare(
      `UPDATE acceptance_team_invitations
          SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?)
        WHERE team_id = ?`,
    ).bind(now, actorId, teamId),
    db.prepare(
      `UPDATE acceptance_project_credentials
          SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?)
        WHERE project_id IN (SELECT id FROM acceptance_projects WHERE team_id = ?)`,
    ).bind(now, actorId, teamId),
  ]);
}

export async function archiveProject(
  db: D1Database,
  projectId: string,
  actorId: string,
): Promise<ProjectSettings | null> {
  const plan = await planArchiveProject(db, projectId, actorId);
  if (!plan) return null;
  await db.batch(plan.statements);
  return plan.body.project as ProjectSettings;
}

export async function archiveTeam(
  db: D1Database,
  teamId: string,
  actorId: string,
): Promise<ArchivedTeam | null> {
  const plan = await planArchiveTeam(db, teamId, actorId);
  if (!plan) return null;
  await db.batch(plan.statements);
  return { teamId, projectIds: plan.body.projectIds as string[] };
}

async function routeRead(request: Request, env: Env, account: NibAccount, parts: string[]): Promise<Response> {
  if (parts.length === 1 && parts[0] === "teams") return listTeams(env.DB, account.id);
  if (parts.length === 2 && parts[0] === "teams") return getTeam(env.DB, parts[1]!, account.id);
  if (parts.length === 3 && parts[0] === "teams" && parts[2] === "members") {
    await requireTeamMember(env.DB, parts[1]!, account.id);
    return listTeamMembers(env.DB, parts[1]!);
  }
  if (parts.length === 4 && parts[0] === "teams" && parts[2] === "members") {
    await requireTeamMember(env.DB, parts[1]!, account.id);
    return json({ member: await teamMemberJson(env.DB, parts[1]!, parts[3]!) });
  }
  if (parts.length === 3 && parts[0] === "teams" && parts[2] === "invitations") {
    await requireTeamManager(env.DB, parts[1]!, account.id);
    return listInvitations(env.DB, parts[1]!);
  }
  if (parts.length === 3 && parts[0] === "teams" && parts[2] === "projects") {
    await requireTeamMember(env.DB, parts[1]!, account.id);
    return listTeamProjects(env.DB, parts[1]!, account.id, env);
  }
  if (parts.length === 2 && parts[0] === "projects") return getProject(env.DB, parts[1]!, account.id);
  if (parts.length === 3 && parts[0] === "projects" && parts[2] === "members") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    return listProjectMembers(env.DB, parts[1]!);
  }
  if (parts.length === 4 && parts[0] === "projects" && parts[2] === "members") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    return json({ member: await projectMemberJson(env.DB, parts[1]!, parts[3]!) });
  }
  if (parts.length === 3 && parts[0] === "projects" && parts[2] === "credentials") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    return listCredentials(env.DB, parts[1]!);
  }
  if (parts.length === 4 && parts[0] === "projects" && parts[2] === "credentials") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    return getCredential(env.DB, parts[1]!, parts[3]!);
  }
  return jsonError("not_found", "Acceptance route not found.", 404);
}

async function routeMutation(
  request: Request,
  env: Env,
  account: NibAccount,
  parts: string[],
  input: unknown,
  idempotency: IdempotencyContext,
): Promise<PlannedMutation> {
  if (parts[0] === "teams" && parts[1] && parts[2] !== "projects") {
    await assertPilotTeamProjects(env, parts[1]);
  }
  if (request.method === "POST" && parts.length === 1 && parts[0] === "teams") {
    return planCreateTeam(env.DB, account, input);
  }
  if (request.method === "PATCH" && parts.length === 2 && parts[0] === "teams") {
    await requireTeamManager(env.DB, parts[1]!, account.id);
    return planUpdateTeam(env.DB, parts[1]!, account.id, input);
  }
  if (request.method === "DELETE" && parts.length === 2 && parts[0] === "teams") {
    await requireTeamOwner(env.DB, parts[1]!, account.id);
    const archived = await planArchiveTeam(env.DB, parts[1]!, account.id);
    if (!archived) throw new HttpError(404, "not_found", "Team not found.");
    return archived;
  }
  if ((request.method === "PATCH" || request.method === "PUT") && parts.length === 4 && parts[0] === "teams" && parts[2] === "members") {
    await requireTeamManager(env.DB, parts[1]!, account.id);
    return planSetTeamMember(env.DB, parts[1]!, parts[3]!, account.id, input);
  }
  if (request.method === "DELETE" && parts.length === 4 && parts[0] === "teams" && parts[2] === "members") {
    await requireTeamManager(env.DB, parts[1]!, account.id);
    return planRemoveTeamMember(env.DB, parts[1]!, parts[3]!, account.id);
  }
  if (request.method === "POST" && parts.length === 3 && parts[0] === "teams" && parts[2] === "invitations") {
    await requireTeamManager(env.DB, parts[1]!, account.id);
    return planCreateInvitation(env, parts[1]!, account, input);
  }
  if (request.method === "DELETE" && parts.length === 4 && parts[0] === "teams" && parts[2] === "invitations") {
    await requireTeamManager(env.DB, parts[1]!, account.id);
    return planRevokeInvitation(env.DB, parts[1]!, parts[3]!, account.id);
  }
  if (request.method === "POST" && parts.length === 5 && parts[0] === "teams" && parts[2] === "invitations" && parts[4] === "resend") {
    await requireTeamManager(env.DB, parts[1]!, account.id);
    return planResendInvitation(env, parts[1]!, parts[3]!, account);
  }
  if (request.method === "POST" && parts.length === 3 && parts[0] === "invitations" && parts[1] && parts[2] === "accept") {
    return planAcceptInvitation(env, parts[1], account);
  }
  if (request.method === "POST" && parts.length === 3 && parts[0] === "teams" && parts[2] === "transfer") {
    await requireTeamOwner(env.DB, parts[1]!, account.id);
    return planTransferTeamOwnership(env.DB, parts[1]!, account.id, input);
  }
  if (request.method === "POST" && parts.length === 3 && parts[0] === "teams" && parts[2] === "projects") {
    await requireTeamManager(env.DB, parts[1]!, account.id);
    return planCreateProject(env.DB, parts[1]!, account, input);
  }
  if (request.method === "PATCH" && parts.length === 2 && parts[0] === "projects") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    return planUpdateProject(env.DB, parts[1]!, account.id, input);
  }
  if (request.method === "DELETE" && parts.length === 2 && parts[0] === "projects") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    const project = await planArchiveProject(env.DB, parts[1]!, account.id);
    if (!project) throw new HttpError(404, "not_found", "Project not found.");
    return project;
  }
  if ((request.method === "PATCH" || request.method === "PUT") && parts.length === 4 && parts[0] === "projects" && parts[2] === "members") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    return planSetProjectMember(env.DB, parts[1]!, parts[3]!, account.id, input);
  }
  if (request.method === "DELETE" && parts.length === 4 && parts[0] === "projects" && parts[2] === "members") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    return planRemoveProjectMember(env.DB, parts[1]!, parts[3]!);
  }
  if (request.method === "POST" && parts.length === 3 && parts[0] === "projects" && parts[2] === "credentials") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    return planCreateCredential(env.DB, parts[1]!, account.id, input);
  }
  if (request.method === "DELETE" && parts.length === 4 && parts[0] === "projects" && parts[2] === "credentials") {
    await requireProjectManage(env.DB, parts[1]!, account.id);
    return planRevokeCredential(env.DB, parts[1]!, parts[3]!, account.id);
  }
  throw new HttpError(404, "not_found", "Acceptance route not found.");
}

async function listTeams(db: D1Database, accountId: string): Promise<Response> {
  const rows = await allRows<TeamRow & { role: TeamRole }>(db.prepare(
    `SELECT t.*, tm.role
      FROM acceptance_team_members tm
      JOIN acceptance_teams t ON t.id = tm.team_id
      WHERE tm.account_id = ? AND t.archived_at IS NULL
      ORDER BY t.created_at DESC, t.name`,
  ).bind(accountId));
  return json({ teams: rows.map((row) => ({ ...teamJson(row), role: row.role })) });
}

async function getTeam(db: D1Database, teamId: string, accountId: string): Promise<Response> {
  const role = await requireTeamMember(db, teamId, accountId);
  const team = await teamById(db, teamId);
  if (!team) throw new HttpError(404, "not_found", "Team not found.");
  return json({ team: { ...teamJson(team), role } });
}

async function planCreateTeam(db: D1Database, account: NibAccount, input: unknown): Promise<PlannedMutation> {
  const body = objectInput(input);
  const name = requiredLabel(body.name, "name");
  const now = unixTime();
  const teamId = crypto.randomUUID();
  const team = {
    id: teamId,
    name,
    default_quorum: DEFAULT_QUORUM,
    default_ttl_seconds: DEFAULT_TTL_SECONDS,
    created_by: account.id,
    created_at: now,
    updated_at: now,
    archived_at: null,
    archived_by: null,
  };
  return mutation(201, { team: { ...teamJson(team), role: "owner" } }, [
    db.prepare(
      `INSERT INTO acceptance_teams
        (id, name, default_quorum, default_ttl_seconds, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(teamId, name, DEFAULT_QUORUM, DEFAULT_TTL_SECONDS, account.id, now, now),
    db.prepare(
      `INSERT INTO acceptance_team_members(team_id, account_id, role, added_by, added_at)
       VALUES (?, ?, 'owner', ?, ?)`,
    ).bind(teamId, account.id, account.id, now),
  ]);
}

async function planUpdateTeam(db: D1Database, teamId: string, accountId: string, input: unknown): Promise<PlannedMutation> {
  const team = await teamById(db, teamId);
  if (!team) throw new HttpError(404, "not_found", "Team not found.");
  const role = await teamRoleFor(db, teamId, accountId);
  const body = objectInput(input);
  const name = optionalLabel(body.name, "name") ?? team.name;
  const quorum = optionalPositiveInteger(body.defaultQuorum, "defaultQuorum") ?? team.default_quorum;
  const ttlSeconds = optionalTtl(body.defaultTtlSeconds, "defaultTtlSeconds") ?? team.default_ttl_seconds;
  const now = unixTime();
  return mutation(200, {
    team: {
      ...teamJson({ ...team, name, default_quorum: quorum, default_ttl_seconds: ttlSeconds, updated_at: now }),
      role,
    },
  }, [db.prepare(
    `UPDATE acceptance_teams
        SET name = ?, default_quorum = ?, default_ttl_seconds = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(name, quorum, ttlSeconds, now, teamId)]);
}

async function listTeamMembers(db: D1Database, teamId: string): Promise<Response> {
  const rows = await allRows<MemberRow>(db.prepare(
    `SELECT tm.account_id, a.email, tm.role, tm.added_at
       FROM acceptance_team_members tm
       JOIN acceptance_teams t ON t.id = tm.team_id
       LEFT JOIN accounts a ON a.account_id = tm.account_id
      WHERE tm.team_id = ? AND t.archived_at IS NULL
      ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, a.email, tm.account_id`,
  ).bind(teamId));
  return json({ members: rows.map(memberJson) });
}

async function planSetTeamMember(
  db: D1Database,
  teamId: string,
  accountId: string,
  actorId: string,
  input: unknown,
): Promise<PlannedMutation> {
  const body = objectInput(input);
  const role = teamRole(body.role);
  if (role === "owner") throw new HttpError(400, "use_transfer", "Transfer ownership with the team transfer endpoint.");
  const account = await accountById(db, accountId);
  if (!account) throw new HttpError(404, "account_not_found", "Account not found.");
  await ensureNotRemovingLastOwner(db, teamId, accountId, role);
  const now = unixTime();
  return mutation(200, {
    member: memberJson({ account_id: accountId, email: account.email, role, added_at: now }),
  }, [db.prepare(
    `INSERT INTO acceptance_team_members(team_id, account_id, role, added_by, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, account_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by, added_at = excluded.added_at`,
  ).bind(teamId, accountId, role, actorId, now)]);
}

async function planRemoveTeamMember(db: D1Database, teamId: string, accountId: string, actorId: string): Promise<PlannedMutation> {
  await ensureNotRemovingLastOwner(db, teamId, accountId, null);
  if (accountId === actorId) {
    const role = await teamRoleFor(db, teamId, actorId);
    if (role === "owner") throw new HttpError(409, "owner_transfer_required", "Transfer ownership before leaving as owner.");
  }
  return mutation(200, { removed: true }, [
    db.prepare("DELETE FROM acceptance_team_members WHERE team_id = ? AND account_id = ?")
      .bind(teamId, accountId),
    db.prepare(
    `DELETE FROM acceptance_project_members
      WHERE account_id = ?
        AND project_id IN (SELECT id FROM acceptance_projects WHERE team_id = ?)`,
    ).bind(accountId, teamId),
  ]);
}

async function planCreateInvitation(env: Env, teamId: string, account: NibAccount, input: unknown): Promise<PlannedMutation> {
  const body = objectInput(input);
  const email = normalizeEmail(body.email);
  if (!email) throw new HttpError(400, "invalid_email", "Invitation email is invalid.");
  if (!(await isPilotEmailAllowed(env, email))) throw new HttpError(403, "pilot_account_required", "Invite an account enabled for the acceptance pilot.");
  const role = inviteRole(body.role ?? "member");
  const now = unixTime();
  const id = crypto.randomUUID();
  const token = randomToken(CREDENTIAL_PREFIX);
  const tokenHash = await sha256(token);
  const expiresAt = now + INVITATION_TTL_SECONDS;
  const acceptUrl = acceptanceUrl(env, token);
  const row: InvitationRow = {
    id,
    team_id: teamId,
    email,
    role,
    created_by: account.id,
    created_at: now,
    expires_at: expiresAt,
    last_sent_at: now,
    accepted_at: null,
    accepted_by: null,
    revoked_at: null,
    revoked_by: null,
  };
  return mutation(201, {
    invitation: invitationJson(row),
    token,
    acceptUrl,
  }, [
    env.DB.prepare(
      `INSERT INTO acceptance_team_invitations
        (id, team_id, email, role, token_hash, created_by, created_at, expires_at, last_sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, teamId, email, role, tokenHash, account.id, now, expiresAt, now),
    invitationEmailOutboxStatement(env.DB, id, email, acceptUrl, expiresAt, now),
  ]);
}

async function listInvitations(db: D1Database, teamId: string): Promise<Response> {
  const rows = await allRows<InvitationRow>(db.prepare(
    `SELECT i.*
       FROM acceptance_team_invitations i
       JOIN acceptance_teams t ON t.id = i.team_id
      WHERE i.team_id = ? AND t.archived_at IS NULL
      ORDER BY i.created_at DESC`,
  ).bind(teamId));
  return json({ invitations: rows.map(invitationJson) });
}

async function planRevokeInvitation(db: D1Database, teamId: string, invitationId: string, actorId: string): Promise<PlannedMutation> {
  const invitation = await db.prepare(
    `SELECT id FROM acceptance_team_invitations
      WHERE team_id = ? AND id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
  ).bind(teamId, invitationId).first<{ id: string }>();
  if (!invitation) throw new HttpError(404, "not_found", "Open invitation not found.");
  return mutation(200, { revoked: true }, [db.prepare(
    `UPDATE acceptance_team_invitations
        SET revoked_at = ?, revoked_by = ?
      WHERE team_id = ? AND id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
  ).bind(unixTime(), actorId, teamId, invitationId)]);
}

async function planResendInvitation(env: Env, teamId: string, invitationId: string, account: NibAccount): Promise<PlannedMutation> {
  const previous = await env.DB.prepare(
    `SELECT i.*
       FROM acceptance_team_invitations i
       JOIN acceptance_teams t ON t.id = i.team_id
      WHERE i.team_id = ? AND i.id = ? AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL AND t.archived_at IS NULL`,
  ).bind(teamId, invitationId).first<InvitationRow>();
  if (!previous) throw new HttpError(404, "not_found", "Open invitation not found.");
  const token = randomToken(CREDENTIAL_PREFIX);
  const now = unixTime();
  const expiresAt = now + INVITATION_TTL_SECONDS;
  const acceptUrl = acceptanceUrl(env, token);
  const row: InvitationRow = {
    ...previous,
    expires_at: expiresAt,
    last_sent_at: now,
  };
  return mutation(200, {
    invitation: invitationJson(row),
    token,
    acceptUrl,
    resent: true,
  }, [
    env.DB.prepare(
    `UPDATE acceptance_team_invitations
        SET token_hash = ?, expires_at = ?, last_sent_at = ?
      WHERE id = ?`,
    ).bind(await sha256(token), expiresAt, now, invitationId),
    invitationEmailOutboxStatement(env.DB, invitationId, previous.email, acceptUrl, expiresAt, now),
  ]);
}

async function planAcceptInvitation(env: Env, token: string, account: NibAccount): Promise<PlannedMutation> {
  const db = env.DB;
  const now = unixTime();
  const row = await db.prepare(
    `SELECT i.*
       FROM acceptance_team_invitations i
       JOIN acceptance_teams t ON t.id = i.team_id
      WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND t.archived_at IS NULL`,
  ).bind(await sha256(token)).first<InvitationRow>();
  if (!row || row.expires_at < now) throw new HttpError(401, "invalid_or_expired_invitation", "Invitation is invalid or expired.");
  if (row.email !== account.email) throw new HttpError(403, "email_mismatch", "Invitation must be accepted by the invited email address.");
  await assertPilotTeamProjects(env, row.team_id);
  return mutation(200, { accepted: true, teamId: row.team_id, role: row.role }, [
    db.prepare(
      `INSERT INTO acceptance_team_members(team_id, account_id, role, added_by, added_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(team_id, account_id) DO UPDATE SET role = excluded.role`,
    ).bind(row.team_id, account.id, row.role, row.created_by, now),
    db.prepare(
      "UPDATE acceptance_team_invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL",
    ).bind(now, account.id, row.id),
  ]);
}

async function planTransferTeamOwnership(db: D1Database, teamId: string, actorId: string, input: unknown): Promise<PlannedMutation> {
  const body = objectInput(input);
  const nextOwnerId = stringValue(body.accountId);
  if (!nextOwnerId) throw new HttpError(400, "invalid_account", "Transfer target account is required.");
  await requireAccount(db, nextOwnerId);
  const targetRole = await teamRoleFor(db, teamId, nextOwnerId);
  if (!targetRole) throw new HttpError(400, "not_team_member", "Transfer target must already be a team member.");
  return mutation(200, { transferred: true, ownerId: nextOwnerId }, [
    db.prepare("UPDATE acceptance_team_members SET role = 'owner' WHERE team_id = ? AND account_id = ?")
      .bind(teamId, nextOwnerId),
    db.prepare("UPDATE acceptance_team_members SET role = 'admin' WHERE team_id = ? AND account_id = ?")
      .bind(teamId, actorId),
  ]);
}

async function listTeamProjects(db: D1Database, teamId: string, accountId: string, pilot: AcceptancePilotEnv): Promise<Response> {
  const teamRole = await teamRoleFor(db, teamId, accountId);
  const sql = teamRole === "owner" || teamRole === "admin"
    ? `SELECT * FROM acceptance_projects WHERE team_id = ? AND archived_at IS NULL ORDER BY created_at DESC`
    : `SELECT p.*
         FROM acceptance_projects p
         JOIN acceptance_project_members pm ON pm.project_id = p.id
        WHERE p.team_id = ? AND pm.account_id = ?
          AND p.archived_at IS NULL
        ORDER BY p.created_at DESC`;
  const rows = await allRows<ProjectRow>(
    teamRole === "owner" || teamRole === "admin"
      ? db.prepare(sql).bind(teamId)
      : db.prepare(sql).bind(teamId, accountId),
  );
  const projects = [];
  for (const row of rows) {
    if (!isPilotProjectAllowed(pilot, row.id)) continue;
    projects.push({ ...projectJson(row), access: await getProjectAccess(db, row.id, accountId) });
  }
  return json({ projects });
}

async function planCreateProject(db: D1Database, teamId: string, account: NibAccount, input: unknown): Promise<PlannedMutation> {
  const body = objectInput(input);
  const name = requiredLabel(body.name, "name");
  const now = unixTime();
  const team = await teamById(db, teamId);
  if (!team) throw new HttpError(404, "not_found", "Team not found.");
  const projectId = crypto.randomUUID();
  const row: ProjectRow = {
    id: projectId,
    team_id: teamId,
    name,
    slug: optionalSlug(body.slug),
    quorum: optionalPositiveInteger(body.quorum, "quorum") ?? team.default_quorum,
    ttl_seconds: optionalTtl(body.ttlSeconds, "ttlSeconds") ?? team.default_ttl_seconds,
    public_read: booleanInt(body.publicRead, false),
    enabled: booleanInt(body.enabled, true),
    created_by: account.id,
    created_at: now,
    updated_at: now,
    archived_at: null,
    archived_by: null,
  };
  const access: ProjectAccess = {
    projectId,
    teamId,
    role: "admin",
    permissions: projectPermissions("admin", row.enabled === 1),
    policy: { quorum: row.quorum, ttlSeconds: row.ttl_seconds },
    publicRead: row.public_read === 1,
    enabled: row.enabled === 1,
  };
  return mutation(201, { project: { ...projectJson(row), access } }, [
    db.prepare(
      `INSERT INTO acceptance_projects
        (id, team_id, name, slug, quorum, ttl_seconds, public_read, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      projectId,
      teamId,
      name,
      row.slug,
      row.quorum,
      row.ttl_seconds,
      row.public_read,
      row.enabled,
      account.id,
      now,
      now,
    ),
    db.prepare(
      `INSERT INTO acceptance_project_members(project_id, account_id, role, added_by, added_at)
       VALUES (?, ?, 'admin', ?, ?)`,
    ).bind(projectId, account.id, account.id, now),
  ]);
}

async function getProject(db: D1Database, projectId: string, accountId: string, status = 200): Promise<Response> {
  const access = await getProjectAccess(db, projectId, accountId);
  if (!access) throw new HttpError(404, "not_found", "Project not found.");
  const project = await projectById(db, projectId);
  if (!project) throw new HttpError(404, "not_found", "Project not found.");
  return json({ project: { ...projectJson(project), access } }, status);
}

async function planUpdateProject(db: D1Database, projectId: string, accountId: string, input: unknown): Promise<PlannedMutation> {
  const project = await projectById(db, projectId);
  if (!project) throw new HttpError(404, "not_found", "Project not found.");
  const body = objectInput(input);
  const now = unixTime();
  const updated: ProjectRow = {
    ...project,
    name: optionalLabel(body.name, "name") ?? project.name,
    slug: body.slug === undefined ? project.slug : optionalSlug(body.slug),
    quorum: optionalPositiveInteger(body.quorum, "quorum") ?? project.quorum,
    ttl_seconds: optionalTtl(body.ttlSeconds, "ttlSeconds") ?? project.ttl_seconds,
    public_read: booleanInt(body.publicRead, project.public_read === 1),
    enabled: booleanInt(body.enabled, project.enabled === 1),
    updated_at: now,
  };
  const access = await getProjectAccess(db, projectId, accountId);
  return mutation(200, {
    project: {
      ...projectJson(updated),
      access: access ? { ...access, policy: { quorum: updated.quorum, ttlSeconds: updated.ttl_seconds }, publicRead: updated.public_read === 1, enabled: updated.enabled === 1, permissions: projectPermissions(access.role, updated.enabled === 1) } : null,
    },
  }, [db.prepare(
    `UPDATE acceptance_projects
        SET name = ?, slug = ?, quorum = ?, ttl_seconds = ?, public_read = ?, enabled = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(
    updated.name,
    updated.slug,
    updated.quorum,
    updated.ttl_seconds,
    updated.public_read,
    updated.enabled,
    now,
    projectId,
  )]);
}

async function listProjectMembers(db: D1Database, projectId: string): Promise<Response> {
  const rows = await allRows<MemberRow>(db.prepare(
    `SELECT pm.account_id, a.email, pm.role, pm.added_at
       FROM acceptance_project_members pm
       JOIN acceptance_projects p ON p.id = pm.project_id
       JOIN acceptance_teams t ON t.id = p.team_id
       LEFT JOIN accounts a ON a.account_id = pm.account_id
      WHERE pm.project_id = ? AND p.archived_at IS NULL AND t.archived_at IS NULL
      ORDER BY CASE pm.role WHEN 'admin' THEN 0 WHEN 'reviewer' THEN 1 ELSE 2 END, a.email, pm.account_id`,
  ).bind(projectId));
  return json({ members: rows.map(memberJson) });
}

async function planSetProjectMember(
  db: D1Database,
  projectId: string,
  accountId: string,
  actorId: string,
  input: unknown,
): Promise<PlannedMutation> {
  const body = objectInput(input);
  const role = projectRole(body.role);
  const account = await accountById(db, accountId);
  if (!account) throw new HttpError(404, "account_not_found", "Account not found.");
  const now = unixTime();
  return mutation(200, {
    member: memberJson({ account_id: accountId, email: account.email, role, added_at: now }),
  }, [db.prepare(
    `INSERT INTO acceptance_project_members(project_id, account_id, role, added_by, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, account_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by, added_at = excluded.added_at`,
  ).bind(projectId, accountId, role, actorId, now)]);
}

async function planRemoveProjectMember(db: D1Database, projectId: string, accountId: string): Promise<PlannedMutation> {
  return mutation(200, { removed: true }, [
    db.prepare("DELETE FROM acceptance_project_members WHERE project_id = ? AND account_id = ?")
      .bind(projectId, accountId),
  ]);
}

async function listCredentials(db: D1Database, projectId: string): Promise<Response> {
  const rows = await allRows<CredentialRow>(db.prepare(
    `SELECT id, project_id, name, scopes, created_at, last_used_at, revoked_at
       FROM acceptance_project_credentials
      WHERE project_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC`,
  ).bind(projectId));
  return json({ credentials: rows.map(credentialJson) });
}

async function getCredential(db: D1Database, projectId: string, credentialId: string): Promise<Response> {
  const row = await db.prepare(
    `SELECT id, project_id, name, scopes, created_at, last_used_at, revoked_at
       FROM acceptance_project_credentials
      WHERE project_id = ? AND id = ? AND revoked_at IS NULL`,
  ).bind(projectId, credentialId).first<CredentialRow>();
  if (!row) throw new HttpError(404, "not_found", "Credential not found.");
  return json({ credential: credentialJson(row) });
}

async function planCreateCredential(db: D1Database, projectId: string, actorId: string, input: unknown): Promise<PlannedMutation> {
  const body = objectInput(input);
  const name = requiredLabel(body.name, "name");
  const scopes = credentialScopes(body.scopes);
  const token = randomToken(CREDENTIAL_PREFIX);
  const id = crypto.randomUUID();
  const now = unixTime();
  const credential = {
    id,
    project_id: projectId,
    name,
    scopes: JSON.stringify(scopes),
    created_at: now,
    last_used_at: null,
    revoked_at: null,
  };
  return mutation(201, {
    credential: credentialJson(credential),
    token,
  }, [db.prepare(
    `INSERT INTO acceptance_project_credentials
      (id, project_id, name, token_hash, scopes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, projectId, name, await sha256(token), JSON.stringify(scopes), actorId, now)]);
}

async function planRevokeCredential(db: D1Database, projectId: string, credentialId: string, actorId: string): Promise<PlannedMutation> {
  const credential = await db.prepare(
    `SELECT id FROM acceptance_project_credentials
      WHERE project_id = ? AND id = ? AND revoked_at IS NULL`,
  ).bind(projectId, credentialId).first<{ id: string }>();
  if (!credential) throw new HttpError(404, "not_found", "Open credential not found.");
  return mutation(200, { revoked: true }, [db.prepare(
    `UPDATE acceptance_project_credentials
        SET revoked_at = ?, revoked_by = ?
      WHERE project_id = ? AND id = ? AND revoked_at IS NULL`,
  ).bind(unixTime(), actorId, projectId, credentialId)]);
}

async function requireProjectManage(db: D1Database, projectId: string, accountId: string): Promise<ProjectAccess> {
  const access = await getProjectAccess(db, projectId, accountId);
  if (!access) throw new HttpError(404, "not_found", "Project not found.");
  if (!access.permissions.manage) throw new HttpError(403, "forbidden", "Project management access is required.");
  return access;
}

async function requireTeamMember(db: D1Database, teamId: string, accountId: string): Promise<TeamRole> {
  const role = await teamRoleFor(db, teamId, accountId);
  if (!role) throw new HttpError(404, "not_found", "Team not found.");
  return role;
}

async function requireTeamManager(db: D1Database, teamId: string, accountId: string): Promise<TeamRole> {
  const role = await requireTeamMember(db, teamId, accountId);
  if (role !== "owner" && role !== "admin") throw new HttpError(403, "forbidden", "Team management access is required.");
  return role;
}

async function requireTeamOwner(db: D1Database, teamId: string, accountId: string): Promise<void> {
  const role = await requireTeamMember(db, teamId, accountId);
  if (role !== "owner") throw new HttpError(403, "forbidden", "Team owner access is required.");
}

async function teamRoleFor(db: D1Database, teamId: string, accountId: string): Promise<TeamRole | null> {
  const row = await db.prepare(
    `SELECT tm.role
       FROM acceptance_team_members tm
       JOIN acceptance_teams t ON t.id = tm.team_id
      WHERE tm.team_id = ? AND tm.account_id = ? AND t.archived_at IS NULL`,
  )
    .bind(teamId, accountId).first<{ role: TeamRole }>();
  return row?.role ?? null;
}

async function ensureNotRemovingLastOwner(
  db: D1Database,
  teamId: string,
  accountId: string,
  nextRole: TeamRole | null,
): Promise<void> {
  const current = await teamRoleFor(db, teamId, accountId);
  if (current !== "owner" || nextRole === "owner") return;
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM acceptance_team_members WHERE team_id = ? AND role = 'owner'",
  ).bind(teamId).first<{ count: number }>();
  if ((row?.count ?? 0) <= 1) {
    throw new HttpError(409, "last_owner", "A team must keep at least one owner.");
  }
}



function projectPermissions(role: ProjectRole, enabled: boolean): ProjectAccess["permissions"] {
  if (!enabled) return { read: false, publish: false, review: false, manage: false };
  if (role === "admin") return { read: true, publish: true, review: true, manage: true };
  if (role === "reviewer") return { read: true, publish: false, review: true, manage: false };
  return { read: true, publish: false, review: false, manage: false };
}

async function requireAccount(db: D1Database, accountId: string): Promise<void> {
  const account = await accountById(db, accountId);
  if (!account) throw new HttpError(404, "account_not_found", "Account not found.");
}

async function withIdempotency(
  request: Request,
  env: Env,
  accountId: string,
  action: (input: unknown, idempotency: IdempotencyContext) => Promise<PlannedMutation>,
): Promise<Response> {
  const db = env.DB;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("idempotency_key_required", "POST, PATCH, and DELETE require Idempotency-Key.", 400);
  if (key.length > 128) return jsonError("invalid_idempotency_key", "Idempotency-Key is too long.", 400);

  const raw = await request.text();
  let input: unknown = {};
  if (raw.trim()) {
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      return jsonError("invalid_json", "Request body must be valid JSON.", 400);
    }
  }

  const requestHash = await sha256(`${request.method}:${new URL(request.url).pathname}:${raw}`);
  const replay = await idempotencyReplay(db, accountId, key, requestHash);
  if (replay) {
    await sendPendingInvitationEmails(env).catch((error) => {
      console.error("Acceptance invitation email outbox drain failed", safeErrorMessage(error));
    });
    return replay;
  }

  const plan = await action(input, { accountId, key, requestHash });
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO acceptance_idempotency(account_id, idempotency_key, request_hash, response_status, response_body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(accountId, key, requestHash, plan.status, JSON.stringify(plan.body), unixTime()),
      ...plan.statements,
    ]);
  } catch (error) {
    const racedReplay = await idempotencyReplay(db, accountId, key, requestHash);
    if (racedReplay) return racedReplay;
    throw error;
  }

  await sendPendingInvitationEmails(env).catch((error) => {
    console.error("Acceptance invitation email outbox drain failed", safeErrorMessage(error));
  });
  return json(plan.body, plan.status);
}

async function idempotencyReplay(
  db: D1Database,
  accountId: string,
  key: string,
  requestHash: string,
): Promise<Response | null> {
  const row = await db.prepare(
    `SELECT request_hash, response_status, response_body
       FROM acceptance_idempotency WHERE account_id = ? AND idempotency_key = ?`,
  ).bind(accountId, key).first<{ request_hash: string; response_status: number; response_body: string }>();
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    return jsonError("idempotency_conflict", "Idempotency-Key was already used for a different request.", 409);
  }
  return json(JSON.parse(row.response_body), row.response_status);
}

export async function sendPendingInvitationEmails(env: Env, limit = 20): Promise<number> {
  const now = unixTime();
  const rows = await allRows<InvitationEmailRow>(env.DB.prepare(
    `UPDATE acceptance_invitation_email_outbox
        SET lease_expires_at = ?, attempts = attempts + 1
      WHERE id IN (
        SELECT o.id
          FROM acceptance_invitation_email_outbox o
          JOIN acceptance_team_invitations i ON i.id = o.invitation_id
         WHERE o.sent_at IS NULL
           AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= ?)
           AND i.accepted_at IS NULL
           AND i.revoked_at IS NULL
           AND i.expires_at > ?
           AND (? = 0 OR EXISTS (
             SELECT 1 FROM accounts a
              WHERE lower(a.email) = lower(o.email)
                AND a.account_id IN (SELECT value FROM json_each(?))
           ))
         ORDER BY o.created_at
         LIMIT ?
      )
      RETURNING id, email, raw_message`,
  ).bind(now + INVITATION_EMAIL_LEASE_SECONDS, now, now, acceptancePilotEnabled(env) ? 1 : 0,
    JSON.stringify(pilotIds(env.ACCEPTANCE_PILOT_ACCOUNT_IDS)), limit));
  let sent = 0;
  for (const row of rows) {
    try {
      if (!(await isPilotEmailAllowed(env, row.email))) {
        await env.DB.prepare("UPDATE acceptance_invitation_email_outbox SET lease_expires_at = NULL, last_error = 'pilot_account_required' WHERE id = ? AND sent_at IS NULL")
          .bind(row.id).run();
        continue;
      }
      await sendInvitationMessage(env, row.email, row.raw_message);
      await env.DB.prepare(
        "UPDATE acceptance_invitation_email_outbox SET sent_at = ?, lease_expires_at = NULL, last_error = NULL WHERE id = ? AND sent_at IS NULL",
      ).bind(unixTime(), row.id).run();
      sent += 1;
    } catch (error) {
      await env.DB.prepare(
        "UPDATE acceptance_invitation_email_outbox SET lease_expires_at = NULL, last_error = ? WHERE id = ? AND sent_at IS NULL",
      ).bind(safeErrorMessage(error), row.id).run();
    }
  }
  return sent;
}

async function assertPilotTeamProjects(env: Env, teamId: string): Promise<void> {
  if (!acceptancePilotEnabled(env)) return;
  const projects = await allRows<{ id: string }>(env.DB.prepare(
    "SELECT id FROM acceptance_projects WHERE team_id = ? AND archived_at IS NULL",
  ).bind(teamId));
  for (const project of projects) assertPilotProject(env, project.id);
}

async function sendInvitationMessage(env: Env, email: string, raw: string): Promise<void> {
  const { EmailMessage } = await import("cloudflare:email");
  await env.EMAIL.send(new EmailMessage(SENDER, email, raw));
}

function invitationRawMessage(email: string, acceptUrl: string, expiresAt: number, messageId: string): string {
  return [
    `From: Nib <${SENDER}>`,
    `To: ${email}`,
    "Subject: Nib acceptance invitation",
    `Message-ID: <${messageId.replace(/[^a-zA-Z0-9:._-]/g, "_")}@nibtool.com>`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "You were invited to a Nib acceptance team.",
    "",
    `Accept the invitation: ${acceptUrl}`,
    `This invitation expires at ${new Date(expiresAt * 1000).toISOString()}.`,
  ].join("\r\n");
}

function invitationEmailOutboxStatement(
  db: D1Database,
  invitationId: string,
  email: string,
  acceptUrl: string,
  expiresAt: number,
  now: number,
): D1PreparedStatement {
  const outboxId = crypto.randomUUID();
  return db.prepare(
    `INSERT INTO acceptance_invitation_email_outbox(id, invitation_id, email, raw_message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(outboxId, invitationId, email, invitationRawMessage(email, acceptUrl, expiresAt, outboxId), now);
}

function acceptanceUrl(env: Env, token: string): string {
  const origin = env.PUBLIC_ORIGIN || "https://nibtool.com";
  return `${origin}/acceptance?invitation=${encodeURIComponent(token)}`;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}

function mutation(status: number, body: Record<string, unknown>, statements: D1PreparedStatement[]): PlannedMutation {
  return { status, body, statements };
}

async function accountById(db: D1Database, accountId: string): Promise<{ account_id: string; email: string } | null> {
  return db.prepare("SELECT account_id, email FROM accounts WHERE account_id = ?")
    .bind(accountId).first<{ account_id: string; email: string }>();
}

async function teamById(db: D1Database, teamId: string): Promise<TeamRow | null> {
  return db.prepare("SELECT * FROM acceptance_teams WHERE id = ? AND archived_at IS NULL")
    .bind(teamId).first<TeamRow>();
}

async function projectById(db: D1Database, projectId: string): Promise<ProjectRow | null> {
  return db.prepare(
    `SELECT p.*
       FROM acceptance_projects p
       JOIN acceptance_teams t ON t.id = p.team_id
      WHERE p.id = ? AND p.archived_at IS NULL AND t.archived_at IS NULL`,
  ).bind(projectId).first<ProjectRow>();
}

async function activeTeamById(db: D1Database, teamId: string): Promise<TeamRow | null> {
  return teamById(db, teamId);
}

async function activeProjectSettings(db: D1Database, projectId: string): Promise<ProjectSettings | null> {
  return getProjectSettings(db, projectId);
}

async function teamMemberJson(db: D1Database, teamId: string, accountId: string) {
  const row = await db.prepare(
    `SELECT tm.account_id, a.email, tm.role, tm.added_at
       FROM acceptance_team_members tm
       JOIN acceptance_teams t ON t.id = tm.team_id
       LEFT JOIN accounts a ON a.account_id = tm.account_id
      WHERE tm.team_id = ? AND tm.account_id = ? AND t.archived_at IS NULL`,
  ).bind(teamId, accountId).first<MemberRow>();
  if (!row) throw new HttpError(404, "not_found", "Team member not found.");
  return memberJson(row);
}

async function projectMemberJson(db: D1Database, projectId: string, accountId: string) {
  const row = await db.prepare(
    `SELECT pm.account_id, a.email, pm.role, pm.added_at
       FROM acceptance_project_members pm
       JOIN acceptance_projects p ON p.id = pm.project_id
       JOIN acceptance_teams t ON t.id = p.team_id
       LEFT JOIN accounts a ON a.account_id = pm.account_id
      WHERE pm.project_id = ? AND pm.account_id = ?
        AND p.archived_at IS NULL AND t.archived_at IS NULL`,
  ).bind(projectId, accountId).first<MemberRow>();
  if (!row) throw new HttpError(404, "not_found", "Project member not found.");
  return memberJson(row);
}

function teamJson(row: TeamRow) {
  return {
    id: row.id,
    name: row.name,
    defaultQuorum: row.default_quorum,
    defaultTtlSeconds: row.default_ttl_seconds,
    createdBy: row.created_by,
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
    archivedAt: row.archived_at ? isoTime(row.archived_at) : null,
    archivedBy: row.archived_by,
  };
}

function projectJson(row: ProjectRow) {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    slug: row.slug,
    policy: { quorum: row.quorum, ttlSeconds: row.ttl_seconds },
    publicRead: row.public_read === 1,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
    archivedAt: row.archived_at ? isoTime(row.archived_at) : null,
    archivedBy: row.archived_by,
  };
}

function memberJson(row: MemberRow) {
  return {
    accountId: row.account_id,
    email: row.email,
    role: row.role,
    addedAt: isoTime(row.added_at),
  };
}

function invitationJson(row: InvitationRow) {
  return {
    id: row.id,
    teamId: row.team_id,
    email: row.email,
    role: row.role,
    createdBy: row.created_by,
    createdAt: isoTime(row.created_at),
    expiresAt: isoTime(row.expires_at),
    lastSentAt: isoTime(row.last_sent_at),
    acceptedAt: row.accepted_at ? isoTime(row.accepted_at) : null,
    acceptedBy: row.accepted_by,
    revokedAt: row.revoked_at ? isoTime(row.revoked_at) : null,
    revokedBy: row.revoked_by,
  };
}

function credentialJson(row: CredentialRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdAt: isoTime(row.created_at),
    lastUsedAt: row.last_used_at ? isoTime(row.last_used_at) : null,
    revokedAt: row.revoked_at ? isoTime(row.revoked_at) : null,
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

function requiredLabel(value: unknown, field: string): string {
  const label = optionalLabel(value, field);
  if (!label) throw new HttpError(400, "invalid_field", `${field} is required.`);
  return label;
}

function optionalLabel(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "invalid_field", `${field} must be a string.`);
  const label = value.trim();
  if (!label || label.length > 120) throw new HttpError(400, "invalid_field", `${field} must be between 1 and 120 characters.`);
  return label;
}

function optionalSlug(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new HttpError(400, "invalid_slug", "slug must use lowercase letters, numbers, and hyphens.");
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new HttpError(400, "invalid_field", `${field} must be a positive integer.`);
  }
  return Number(value);
}

function optionalTtl(value: unknown, field: string): number | undefined {
  const ttl = optionalPositiveInteger(value, field);
  if (ttl === undefined) return undefined;
  if (ttl < 60 || ttl > DEFAULT_TTL_SECONDS) {
    throw new HttpError(400, "invalid_ttl", `${field} must be between 60 and 604800 seconds.`);
  }
  return ttl;
}

function booleanInt(value: unknown, defaultValue: boolean): number {
  if (value === undefined) return defaultValue ? 1 : 0;
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_field", "Boolean setting must be true or false.");
  return value ? 1 : 0;
}

function teamRole(value: unknown): TeamRole {
  if (value === "owner" || value === "admin" || value === "member") return value;
  throw new HttpError(400, "invalid_role", "Team role must be owner, admin, or member.");
}

function inviteRole(value: unknown): InviteRole {
  if (value === "admin" || value === "member") return value;
  throw new HttpError(400, "invalid_role", "Invitation role must be admin or member.");
}

function projectRole(value: unknown): ProjectRole {
  if (value === "admin" || value === "reviewer" || value === "viewer") return value;
  throw new HttpError(400, "invalid_role", "Project role must be admin, reviewer, or viewer.");
}

function credentialScopes(value: unknown): CredentialScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "invalid_scopes", "Credential scopes are required.");
  }
  const scopes = [...new Set(value.map((scope) => {
    if (scope === "publish" || scope === "read" || scope === "verify") return scope;
    throw new HttpError(400, "invalid_scopes", "Credential scopes must be publish, read, or verify.");
  }))];
  return scopes;
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === "string") : [];
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function allRows<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}

function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${base64Url(bytes)}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let value = "";
  for (const byte of view) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isoTime(value: number): string {
  return new Date(value * 1000).toISOString();
}

function unixTime(): number {
  return Math.floor(Date.now() / 1000);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function jsonError(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
