import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class TestEmailMessage {
  constructor(readonly from: string, readonly to: string, readonly raw: string) {}
}

vi.mock("cloudflare:email", () => ({ EmailMessage: TestEmailMessage }));

import {
  assertCanDeleteAccount,
  authenticateAutomation,
  getProjectAccess,
  getProjectSettings,
  handleTeamRoutes,
  listEligibleReviewers,
  listProjectRecipients,
  removeAccountMemberships,
  sendPendingInvitationEmails,
} from "./teams";
import {
  createAcceptanceTeamTestFixture,
  type AcceptanceTeamTestFixture,
} from "./team-test-db";
import type { NibAccount } from "../account-auth";
import type { Env } from "../types";

type Fixture = {
  sqlite: AcceptanceTeamTestFixture["sqlite"];
  db: AcceptanceTeamTestFixture["db"];
  env: Env;
  sentEmails: unknown[];
  failEmail: boolean;
  beforeSend?: () => Promise<void> | void;
};

const accounts = {
  owner: account("account-owner", "owner@example.com"),
  admin: account("account-admin", "admin@example.com"),
  reviewer: account("account-reviewer", "reviewer@example.com"),
  member: account("account-member", "member@example.com"),
  other: account("account-other", "other@example.com"),
};

let fixtures: Fixture[] = [];

beforeEach(async () => {
  fixtures = [];
});

afterEach(() => {
  for (const fixture of fixtures) fixture.sqlite.close();
});

describe("acceptance team routes", () => {
  it("allows pilot bootstrap while hiding and denying projects until listed", async () => {
    const f = await fixture();
    f.env.ACCEPTANCE_PILOT_ACCOUNT_IDS = accounts.owner.id;
    f.env.ACCEPTANCE_PILOT_PROJECT_IDS = "";
    const teamId = await createTeam(f);
    const projectId = await createProject(f, teamId);
    expect((await api(f, accounts.other, "GET", "/teams")).status).toBe(403);
    expect((await api(f, accounts.owner, "GET", `/projects/${projectId}`)).status).toBe(403);
    await expect((await api(f, accounts.owner, "GET", `/teams/${teamId}/projects`)).json()).resolves.toEqual({ projects: [] });
    f.env.ACCEPTANCE_PILOT_PROJECT_IDS = projectId;
    expect((await api(f, accounts.owner, "GET", `/projects/${projectId}`)).status).toBe(200);
  });

  it("does not let team-level changes alter projects outside the pilot", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    const projectId = await createProject(f, teamId);
    expect((await api(f, accounts.owner, "PUT", `/teams/${teamId}/members/${accounts.reviewer.id}`, { role: "member" }, "add-member")).status).toBe(200);
    f.env.ACCEPTANCE_PILOT_ACCOUNT_IDS = accounts.owner.id;
    f.env.ACCEPTANCE_PILOT_PROJECT_IDS = "";
    expect((await api(f, accounts.owner, "DELETE", `/teams/${teamId}`, undefined, "archive-team")).status).toBe(403);
    expect((await api(f, accounts.owner, "DELETE", `/teams/${teamId}/members/${accounts.reviewer.id}`, undefined, "remove-member")).status).toBe(403);
    expect((await api(f, accounts.owner, "PUT", `/teams/${teamId}/members/${accounts.reviewer.id}`, { role: "admin" }, "promote-member")).status).toBe(403);
    expect((await getProjectSettings(f.env.DB, projectId))?.enabled).toBe(true);
    expect(f.sqlite.prepare("SELECT role FROM acceptance_team_members WHERE team_id = ? AND account_id = ?").get(teamId, accounts.reviewer.id)?.role).toBe("member");
    f.env.ACCEPTANCE_PILOT_PROJECT_IDS = projectId;
    expect((await api(f, accounts.owner, "DELETE", `/teams/${teamId}`, undefined, "archive-after-enable")).status).toBe(200);
  });

  it("does not send invitations to accounts outside the pilot, including queued retries", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    f.failEmail = true;
    expect((await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, { email: accounts.other.email }, "queued-before-pilot")).status).toBe(201);
    f.env.ACCEPTANCE_PILOT_ACCOUNT_IDS = `${accounts.owner.id},${accounts.reviewer.id}`;
    f.env.ACCEPTANCE_PILOT_PROJECT_IDS = "";
    f.failEmail = false;
    await sendPendingInvitationEmails(f.env);
    expect(f.sentEmails).toHaveLength(0);
    expect((await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, { email: accounts.other.email }, "outside-pilot")).status).toBe(403);
    expect((await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, { email: accounts.reviewer.email }, "inside-pilot")).status).toBe(201);
    expect(f.sentEmails).toHaveLength(1);
    expect((f.sentEmails[0] as TestEmailMessage).to).toBe(accounts.reviewer.email);
  });

  it("does not let queued non-pilot invitations starve the pilot delivery batch", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    f.failEmail = true;
    await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, { email: accounts.other.email }, "outside-first");
    await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, { email: accounts.reviewer.email }, "inside-second");
    f.env.ACCEPTANCE_PILOT_ACCOUNT_IDS = `${accounts.owner.id},${accounts.reviewer.id}`;
    f.env.ACCEPTANCE_PILOT_PROJECT_IDS = "";
    f.failEmail = false;
    expect(await sendPendingInvitationEmails(f.env, 1)).toBe(1);
    expect((f.sentEmails[0] as TestEmailMessage).to).toBe(accounts.reviewer.email);
  });

  it("creates and lists teams with idempotent owner membership", async () => {
    const f = await fixture();

    const first = await api(f, accounts.owner, "POST", "/teams", { name: "Core Product" }, "create-team");
    expect(first.status).toBe(201);
    const created = await first.json() as { team: { id: string; role: string } };

    const replay = await api(f, accounts.owner, "POST", "/teams", { name: "Core Product" }, "create-team");
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toMatchObject({ team: { id: created.team.id, role: "owner" } });

    const conflict = await api(f, accounts.owner, "POST", "/teams", { name: "Other" }, "create-team");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "idempotency_conflict" } });

    const list = await api(f, accounts.owner, "GET", "/teams");
    await expect(list.json()).resolves.toMatchObject({ teams: [{ id: created.team.id, role: "owner" }] });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_teams").get()?.count).toBe(1);
    expect(f.sqlite.prepare("SELECT role FROM acceptance_team_members WHERE account_id = ?").get(accounts.owner.id)?.role).toBe("owner");
  });

  it("keeps idempotency replay isolated by request and actor without pending rows", async () => {
    const f = await fixture();
    const owner = await api(f, accounts.owner, "POST", "/teams", { name: "Owner Team" }, "shared-key");
    const ownerBody = await owner.json() as { team: { id: string; createdBy: string } };
    const replay = await api(f, accounts.owner, "POST", "/teams", { name: "Owner Team" }, "shared-key");
    await expect(replay.json()).resolves.toMatchObject({ team: { id: ownerBody.team.id } });

    const changedPayload = await api(f, accounts.owner, "POST", "/teams", { name: "Changed Team" }, "shared-key");
    expect(changedPayload.status).toBe(409);
    await expect(changedPayload.json()).resolves.toMatchObject({ error: { code: "idempotency_conflict" } });

    const other = await api(f, accounts.other, "POST", "/teams", { name: "Other Team" }, "shared-key");
    const otherBody = await other.json() as { team: { id: string; createdBy: string } };
    expect(otherBody.team.id).not.toBe(ownerBody.team.id);
    expect(ownerBody.team.createdBy).toBe(accounts.owner.id);
    expect(otherBody.team.createdBy).toBe(accounts.other.id);
  });

  it("keeps invitations email-bound, expiring, revocable, and resendable", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);

    const invite = await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, {
      email: " Reviewer@Example.com ",
      role: "member",
    }, "invite-reviewer");
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json() as { invitation: { id: string; email: string }; token: string };
    expect(inviteBody.invitation.email).toBe("reviewer@example.com");
    expect(f.sentEmails).toHaveLength(1);
    const emailMessage = f.sentEmails[0] as TestEmailMessage;
    expect(emailMessage).toBeInstanceOf(TestEmailMessage);
    expect(emailMessage.from).toBe("login@nibtool.com");
    expect(emailMessage.raw).toContain(`https://nib.example.com/acceptance?invitation=${inviteBody.token}`);
    expect(emailMessage.raw).toMatch(/Message-ID: <[a-f0-9-]+@nibtool\.com>/);
    expect(emailMessage.raw).not.toContain("/api/acceptance/v1/invitations/");

    const stored = f.sqlite.prepare("SELECT token_hash FROM acceptance_team_invitations WHERE id = ?")
      .get(inviteBody.invitation.id);
    expect(stored?.token_hash).not.toBe(inviteBody.token);
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const wrongEmail = await api(f, accounts.other, "POST", `/invitations/${inviteBody.token}/accept`, {}, "accept-wrong-email");
    expect(wrongEmail.status).toBe(403);
    await expect(wrongEmail.json()).resolves.toMatchObject({ error: { code: "email_mismatch" } });

    const accepted = await api(f, accounts.reviewer, "POST", `/invitations/${inviteBody.token}/accept`, {}, "accept-reviewer");
    expect(accepted.status).toBe(200);
    expect(f.sqlite.prepare("SELECT role FROM acceptance_team_members WHERE team_id = ? AND account_id = ?")
      .get(teamId, accounts.reviewer.id)?.role).toBe("member");
    const projectId = await createProject(f, teamId);
    const assigned = await api(
      f,
      accounts.owner,
      "PATCH",
      `/projects/${projectId}/members/${accounts.reviewer.id}`,
      { role: "reviewer" },
      "assign-accepted-reviewer",
    );
    expect(assigned.status).toBe(200);
    await expect(getProjectAccess(f.db as unknown as D1Database, projectId, accounts.reviewer.id))
      .resolves.toMatchObject({ role: "reviewer", permissions: { review: true, manage: false } });

    const resendSource = await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, {
      email: accounts.member.email,
      role: "member",
    }, "invite-member");
    const resendSourceBody = await resendSource.json() as { invitation: { id: string }; token: string };
    const resent = await api(
      f,
      accounts.owner,
      "POST",
      `/teams/${teamId}/invitations/${resendSourceBody.invitation.id}/resend`,
      {},
      "resend-member",
    );
    const resentBody = await resent.json() as { token: string; resent: boolean };
    expect(resentBody.resent).toBe(true);
    expect(resentBody.token).not.toBe(resendSourceBody.token);
    expect((await api(f, accounts.member, "POST", `/invitations/${resendSourceBody.token}/accept`, {}, "accept-old-token")).status).toBe(401);

    const revoked = await api(
      f,
      accounts.owner,
      "DELETE",
      `/teams/${teamId}/invitations/${resendSourceBody.invitation.id}`,
      {},
      "revoke-member",
    );
    expect(revoked.status).toBe(200);
    expect((await api(f, accounts.member, "POST", `/invitations/${resentBody.token}/accept`, {}, "accept-revoked")).status).toBe(401);

    const expired = await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, {
      email: accounts.other.email,
      role: "member",
    }, "invite-expiring");
    const expiredBody = await expired.json() as { invitation: { id: string }; token: string };
    f.sqlite.prepare("UPDATE acceptance_team_invitations SET expires_at = 1 WHERE id = ?").run(expiredBody.invitation.id);
    expect((await api(f, accounts.other, "POST", `/invitations/${expiredBody.token}/accept`, {}, "accept-expired")).status).toBe(401);
  });

  it("commits invitation response and outbox before email delivery retry", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    f.failEmail = true;

    const response = await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, {
      email: accounts.member.email,
      role: "member",
    }, "invite-outbox");
    expect(response.status).toBe(201);
    const body = await response.json() as { invitation: { id: string }; token: string; acceptUrl: string };
    expect(body.acceptUrl).toBe(`https://nib.example.com/acceptance?invitation=${body.token}`);
    expect(f.sentEmails).toHaveLength(0);

    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_team_invitations WHERE id = ?")
      .get(body.invitation.id)?.count).toBe(1);
    const outbox = f.sqlite.prepare("SELECT sent_at, lease_expires_at, attempts, raw_message FROM acceptance_invitation_email_outbox WHERE invitation_id = ?")
      .get(body.invitation.id);
    expect(outbox?.sent_at).toBeNull();
    expect(outbox?.lease_expires_at).toBeNull();
    expect(outbox?.attempts).toBe(1);
    expect(String(outbox?.raw_message)).toContain(body.acceptUrl);

    f.failEmail = false;
    const replay = await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, {
      email: accounts.member.email,
      role: "member",
    }, "invite-outbox");
    await expect(replay.json()).resolves.toMatchObject({ invitation: { id: body.invitation.id }, token: body.token });
    expect(f.sentEmails).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT sent_at FROM acceptance_invitation_email_outbox WHERE invitation_id = ?")
      .get(body.invitation.id)?.sent_at).toBeGreaterThan(0);

    await expect(sendPendingInvitationEmails(f.env)).resolves.toBe(0);
  });

  it("leases invitation email delivery so concurrent drains do not duplicate sends", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    f.failEmail = true;

    const response = await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, {
      email: accounts.member.email,
      role: "member",
    }, "invite-concurrent-outbox");
    const body = await response.json() as { invitation: { id: string } };
    f.failEmail = false;

    let releaseSend!: () => void;
    const firstSendStarted = new Promise<void>((resolve) => {
      f.beforeSend = async () => {
        f.beforeSend = undefined;
        resolve();
        await new Promise<void>((release) => { releaseSend = release; });
      };
    });

    const firstDrain = sendPendingInvitationEmails(f.env);
    await firstSendStarted;
    await expect(sendPendingInvitationEmails(f.env)).resolves.toBe(0);
    releaseSend();
    await expect(firstDrain).resolves.toBe(1);

    expect(f.sentEmails).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT sent_at, lease_expires_at, attempts FROM acceptance_invitation_email_outbox WHERE invitation_id = ?")
      .get(body.invitation.id)).toMatchObject({ lease_expires_at: null, attempts: 2 });
  });

  it("skips revoked, accepted, and expired invitations while draining email outbox", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);

    for (const [email, mutation] of [
      [accounts.member.email, "revoked_at = 2"],
      [accounts.reviewer.email, "accepted_at = 2, accepted_by = 'account-reviewer'"],
      [accounts.other.email, "expires_at = 1"],
    ] as const) {
      f.failEmail = true;
      const response = await api(f, accounts.owner, "POST", `/teams/${teamId}/invitations`, { email, role: "member" }, `invite-skip-${email}`);
      const body = await response.json() as { invitation: { id: string } };
      f.sqlite.prepare(`UPDATE acceptance_team_invitations SET ${mutation} WHERE id = ?`).run(body.invitation.id);
    }

    f.failEmail = false;
    await expect(sendPendingInvitationEmails(f.env)).resolves.toBe(0);
    expect(f.sentEmails).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_invitation_email_outbox WHERE sent_at IS NULL")
      .get()?.count).toBe(3);
  });

  it("protects the last owner and exposes deletion helpers", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);

    const rejected = await api(f, accounts.owner, "DELETE", `/teams/${teamId}/members/${accounts.owner.id}`, {}, "remove-last-owner");
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "last_owner" } });

    await api(f, accounts.owner, "PATCH", `/teams/${teamId}/members/${accounts.admin.id}`, { role: "admin" }, "add-admin");
    const transfer = await api(f, accounts.owner, "POST", `/teams/${teamId}/transfer`, { accountId: accounts.admin.id }, "transfer-owner");
    expect(transfer.status).toBe(200);
    expect(f.sqlite.prepare("SELECT role FROM acceptance_team_members WHERE team_id = ? AND account_id = ?")
      .get(teamId, accounts.admin.id)?.role).toBe("owner");
    expect(f.sqlite.prepare("SELECT role FROM acceptance_team_members WHERE team_id = ? AND account_id = ?")
      .get(teamId, accounts.owner.id)?.role).toBe("admin");
    await expect((await api(f, accounts.admin, "GET", `/teams/${teamId}/members/${accounts.owner.id}`)).json())
      .resolves.toMatchObject({ member: { accountId: accounts.owner.id, role: "admin" } });

    await expect(assertCanDeleteAccount(f.db as unknown as D1Database, accounts.owner.id)).resolves.toBeUndefined();
    await expect(assertCanDeleteAccount(f.db as unknown as D1Database, accounts.admin.id)).rejects.toThrow("acceptance_last_owner");

    await removeAccountMemberships(f.db as unknown as D1Database, accounts.owner.id);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_team_members WHERE account_id = ?")
      .get(accounts.owner.id)?.count).toBe(0);
  });

  it("resolves project roles, settings, reviewers, and recipients from server-side membership", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    await api(f, accounts.owner, "PATCH", `/teams/${teamId}/members/${accounts.member.id}`, { role: "member" }, "add-plain-member");
    const projectId = await createProject(f, teamId);

    const memberProjects = await api(f, accounts.member, "GET", `/teams/${teamId}/projects`);
    await expect(memberProjects.json()).resolves.toEqual({ projects: [] });
    expect(await getProjectAccess(f.db as unknown as D1Database, projectId, accounts.member.id)).toBeNull();

    await api(f, accounts.owner, "PATCH", `/projects/${projectId}/members/${accounts.reviewer.id}`, { role: "reviewer" }, "add-reviewer");
    const reviewerAccess = await getProjectAccess(f.db as unknown as D1Database, projectId, accounts.reviewer.id);
    expect(reviewerAccess).toMatchObject({
      role: "reviewer",
      permissions: { read: true, publish: false, review: true, manage: false },
      policy: { quorum: 1, ttlSeconds: 604800 },
    });

    const project = await api(f, accounts.reviewer, "GET", `/projects/${projectId}`);
    await expect(project.json()).resolves.toMatchObject({
      project: {
        id: projectId,
        access: { role: "reviewer", permissions: { review: true, manage: false } },
      },
    });
    await expect((await api(f, accounts.owner, "GET", `/projects/${projectId}/members/${accounts.reviewer.id}`)).json())
      .resolves.toMatchObject({ member: { accountId: accounts.reviewer.id, role: "reviewer" } });

    await expect(listEligibleReviewers(f.db as unknown as D1Database, projectId)).resolves.toEqual([
      accounts.owner.id,
      accounts.reviewer.id,
    ]);
    await expect(listProjectRecipients(f.db as unknown as D1Database, projectId)).resolves.toEqual([
      { accountId: accounts.owner.id, email: accounts.owner.email },
      { accountId: accounts.reviewer.id, email: accounts.reviewer.email },
    ]);
    await expect(getProjectSettings(f.db as unknown as D1Database, projectId)).resolves.toMatchObject({
      id: projectId,
      teamId,
      quorum: 1,
      ttlSeconds: 604800,
      publicRead: false,
      enabled: true,
    });

    const disabled = await api(f, accounts.owner, "PATCH", `/projects/${projectId}`, { enabled: false }, "disable-project");
    expect(disabled.status).toBe(200);
    await expect(getProjectAccess(f.db as unknown as D1Database, projectId, accounts.reviewer.id)).resolves.toMatchObject({
      permissions: { read: false, publish: false, review: false, manage: false },
      enabled: false,
    });
    await expect(listEligibleReviewers(f.db as unknown as D1Database, projectId)).resolves.toEqual([]);
  });

  it("removes integration access after project role downgrade and removal", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    const projectId = await createProject(f, teamId);
    await api(f, accounts.owner, "PATCH", `/projects/${projectId}/members/${accounts.reviewer.id}`, { role: "reviewer" }, "reviewer-access");
    await expect(getProjectAccess(f.db as unknown as D1Database, projectId, accounts.reviewer.id))
      .resolves.toMatchObject({ permissions: { read: true, review: true, publish: false, manage: false } });

    const downgrade = await api(f, accounts.owner, "PATCH", `/projects/${projectId}/members/${accounts.reviewer.id}`, { role: "viewer" }, "downgrade-reviewer");
    expect(downgrade.status).toBe(200);
    await expect(getProjectAccess(f.db as unknown as D1Database, projectId, accounts.reviewer.id))
      .resolves.toMatchObject({ role: "viewer", permissions: { read: true, review: false, publish: false, manage: false } });
    await expect(listEligibleReviewers(f.db as unknown as D1Database, projectId)).resolves.toEqual([accounts.owner.id]);

    const removed = await api(f, accounts.owner, "DELETE", `/projects/${projectId}/members/${accounts.reviewer.id}`, {}, "remove-reviewer");
    expect(removed.status).toBe(200);
    await expect(getProjectAccess(f.db as unknown as D1Database, projectId, accounts.reviewer.id)).resolves.toBeNull();
  });

  it("archives projects without deleting audit rows or leaving active access", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    const projectId = await createProject(f, teamId);
    await api(f, accounts.owner, "PATCH", `/projects/${projectId}/members/${accounts.reviewer.id}`, { role: "reviewer" }, "archive-reviewer");
    const credential = await api(f, accounts.owner, "POST", `/projects/${projectId}/credentials`, {
      name: "CI publisher",
      scopes: ["publish"],
    }, "archive-credential");
    const credentialBody = await credential.json() as { token: string };

    const archived = await api(f, accounts.owner, "DELETE", `/projects/${projectId}`, {}, "archive-project");
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ archived: true, project: { id: projectId, teamId } });
    const stored = f.sqlite.prepare("SELECT archived_at, enabled, public_read FROM acceptance_projects WHERE id = ?").get(projectId);
    expect(stored?.archived_at).toBeGreaterThan(0);
    expect(stored?.enabled).toBe(0);
    expect(stored?.public_read).toBe(0);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_project_members WHERE project_id = ?").get(projectId)?.count).toBe(0);

    expect((await api(f, accounts.owner, "GET", `/projects/${projectId}`)).status).toBe(404);
    await expect(getProjectAccess(f.db as unknown as D1Database, projectId, accounts.owner.id)).resolves.toBeNull();
    await expect(getProjectSettings(f.db as unknown as D1Database, projectId)).resolves.toBeNull();
    await expect(listEligibleReviewers(f.db as unknown as D1Database, projectId)).resolves.toEqual([]);
    await expect(authenticateAutomation(f.db as unknown as D1Database, credentialBody.token)).resolves.toBeNull();
  });

  it("archives teams and their projects while allowing owner account cleanup", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    const projectId = await createProject(f, teamId);
    await api(f, accounts.owner, "PATCH", `/projects/${projectId}/members/${accounts.reviewer.id}`, { role: "reviewer" }, "team-archive-reviewer");

    const archived = await api(f, accounts.owner, "DELETE", `/teams/${teamId}`, {}, "archive-team");
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ archived: true, teamId, projectIds: [projectId] });
    expect(f.sqlite.prepare("SELECT archived_at FROM acceptance_teams WHERE id = ?").get(teamId)?.archived_at).toBeGreaterThan(0);
    expect(f.sqlite.prepare("SELECT archived_at, enabled FROM acceptance_projects WHERE id = ?").get(projectId))
      .toMatchObject({ enabled: 0 });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_project_members WHERE project_id = ?").get(projectId)?.count).toBe(0);

    expect((await api(f, accounts.owner, "GET", `/teams/${teamId}`)).status).toBe(404);
    expect((await api(f, accounts.owner, "GET", `/projects/${projectId}`)).status).toBe(404);
    await expect(getProjectAccess(f.db as unknown as D1Database, projectId, accounts.owner.id)).resolves.toBeNull();
    await expect(assertCanDeleteAccount(f.db as unknown as D1Database, accounts.owner.id)).resolves.toBeUndefined();
    await removeAccountMemberships(f.db as unknown as D1Database, accounts.owner.id);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_team_members WHERE team_id = ?").get(teamId)?.count).toBe(0);
  });

  it("issues scoped automation credentials as hashed project tokens", async () => {
    const f = await fixture();
    const teamId = await createTeam(f);
    const projectId = await createProject(f, teamId);

    const response = await api(f, accounts.owner, "POST", `/projects/${projectId}/credentials`, {
      name: "CI publisher",
      scopes: ["publish", "read", "publish"],
    }, "create-credential");
    expect(response.status).toBe(201);
    const body = await response.json() as { credential: { id: string; scopes: string[] }; token: string };
    expect(body.credential.scopes).toEqual(["publish", "read"]);
    expect(body.token).toMatch(/^nib_acceptance_/);
    expect(f.sqlite.prepare("SELECT token_hash FROM acceptance_project_credentials WHERE id = ?")
      .get(body.credential.id)?.token_hash).not.toBe(body.token);
    await expect((await api(f, accounts.owner, "GET", `/projects/${projectId}/credentials/${body.credential.id}`)).json())
      .resolves.toMatchObject({ credential: { id: body.credential.id, scopes: ["publish", "read"] } });

    await expect(authenticateAutomation(f.db as unknown as D1Database, body.token)).resolves.toEqual({
      id: body.credential.id,
      projectId,
      scopes: ["publish", "read"],
    });

    const revoke = await api(f, accounts.owner, "DELETE", `/projects/${projectId}/credentials/${body.credential.id}`, {}, "revoke-credential");
    expect(revoke.status).toBe(200);
    await expect(authenticateAutomation(f.db as unknown as D1Database, body.token)).resolves.toBeNull();
  });
});

async function fixture(): Promise<Fixture> {
  const { sqlite, db } = await createAcceptanceTeamTestFixture({
    accounts: Object.values(accounts),
  });
  const sentEmails: unknown[] = [];
  const f: Fixture = { sqlite, db, env: undefined as unknown as Env, sentEmails, failEmail: false };
  const env = {
    DB: db as unknown as D1Database,
    PUBLIC_ORIGIN: "https://nib.example.com",
    EMAIL: {
      send: async (message: unknown) => {
        if (f.failEmail) throw new Error("email unavailable");
        await f.beforeSend?.();
        sentEmails.push(message);
      },
    },
  } as unknown as Env;
  f.env = env;
  fixtures.push(f);
  return f;
}

function account(id: string, email: string): NibAccount {
  return { id, email, sessionId: `${id}-session`, sessionName: "test", platform: "web" };
}

async function api(
  fixture: Fixture,
  account: NibAccount,
  method: string,
  path: string,
  body?: unknown,
  key?: string,
): Promise<Response> {
  const headers = new Headers();
  if (key) headers.set("Idempotency-Key", key);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await handleTeamRoutes(
    new Request(`https://nib.example.com/api/acceptance/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    fixture.env,
    account,
  );
  if (!response) throw new Error(`Route did not handle ${method} ${path}`);
  return response;
}

async function createTeam(fixture: Fixture): Promise<string> {
  const response = await api(fixture, accounts.owner, "POST", "/teams", { name: "Acceptance" }, crypto.randomUUID());
  const body = await response.json() as { team: { id: string } };
  return body.team.id;
}

async function createProject(fixture: Fixture, teamId: string): Promise<string> {
  const response = await api(
    fixture,
    accounts.owner,
    "POST",
    `/teams/${teamId}/projects`,
    { name: "Website", slug: `website-${crypto.randomUUID().slice(0, 8)}` },
    crypto.randomUUID(),
  );
  const body = await response.json() as { project: { id: string } };
  return body.project.id;
}
