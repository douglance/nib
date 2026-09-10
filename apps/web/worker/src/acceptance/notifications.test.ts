import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptanceTeamTestFixture, type AcceptanceTeamTestFixture } from "./team-test-db";
import { acceptanceMail, deliverAcceptanceNotifications } from "./notifications";
import type { AcceptanceEvent } from "./contracts";
import type { Env } from "../types";

const projectId = "11111111-1111-4111-8111-111111111111";
const reviewId = "22222222-2222-4222-8222-222222222222";
const review = { id: reviewId, projectId, state: "pending", revision: 1, manifestHash: "a".repeat(64), expiresAt: "2026-09-16T00:00:00.000Z", manifest: { title: "A requested change", change: "Projects now have roles." } };
const event = { id: "event-1", type: "acceptance.changed", projectId, reviewId, subject: "pr:1", gate: "acceptance", revision: 1, sequence: 1, state: "pending", manifestHash: review.manifestHash, occurredAt: "2026-09-09T00:00:00.000Z", receipt: null, manifest: review.manifest } as AcceptanceEvent;
let fixture: AcceptanceTeamTestFixture;
let env: Env;
let inbox: ReturnType<typeof vi.fn>;
let readReview: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fixture = await createAcceptanceTeamTestFixture({ accounts: [
    { id: "owner", email: "owner@example.com" }, { id: "reviewer", email: "reviewer@example.com" }, { id: "outsider", email: "outsider@example.com" },
  ], migrations: ["0017_acceptance_delivery_and_evidence.sql"] });
  fixture.sqlite.exec(`INSERT INTO acceptance_teams(id,name,created_by,created_at,updated_at) VALUES ('team','Team','owner',1,1);
    INSERT INTO acceptance_team_members(team_id,account_id,role,added_by,added_at) VALUES ('team','owner','owner','owner',1),('team','reviewer','member','owner',1);
    INSERT INTO acceptance_projects(id,team_id,name,created_by,created_at,updated_at) VALUES ('${projectId}','team','Project','owner',1,1);
    INSERT INTO acceptance_project_members(project_id,account_id,role,added_by,added_at) VALUES ('${projectId}','reviewer','reviewer','owner',1);`);
  inbox = vi.fn(async () => Response.json({ delivered: true }));
  readReview = vi.fn(async () => review);
  env = { ACCEPTANCE_ENABLED: "true", DB: fixture.db, PUBLIC_ORIGIN: "https://nib.test", REVIEW: { fetch: inbox }, ACCEPTANCE: { idFromName: (id: string) => id, get: () => ({ getReview: readReview }) } } as unknown as Env;
});
afterEach(() => fixture.sqlite.close());

describe("team acceptance delivery", () => {
  it("delivers pilot notifications only to listed accounts and projects", async () => {
    const email = vi.fn(async () => {});
    const pilot = { ...env, ACCEPTANCE_PILOT_ACCOUNT_IDS: "owner", ACCEPTANCE_PILOT_PROJECT_IDS: projectId };
    await deliverAcceptanceNotifications(event, { ...pilot, ACCEPTANCE_PILOT_PROJECT_IDS: "" }, email);
    expect(inbox).not.toHaveBeenCalled();
    await deliverAcceptanceNotifications(event, pilot, email);
    expect(email).toHaveBeenCalledTimes(1);
    expect((email.mock.calls[0] as unknown[])[1]).toBe("owner@example.com");
    expect(inbox).toHaveBeenCalledTimes(1);
  });

  it("fans one canonical review out to eligible members, without replaying notifications on comments", async () => {
    const email = vi.fn(async () => {});
    await deliverAcceptanceNotifications(event, env, email);
    await deliverAcceptanceNotifications({ ...event, id: "comment-event", sequence: 2 }, env, email);
    expect(email).toHaveBeenCalledTimes(2);
    expect(inbox).toHaveBeenCalledTimes(2);
    expect(email.mock.calls.map(call => (call as unknown[])[1]).sort()).toEqual(["owner@example.com", "reviewer@example.com"]);
    const payloads = await Promise.all(inbox.mock.calls.map(call => (call[0] as Request).json()));
    expect(payloads.every(payload => (payload as { reviewId: string }).reviewId === reviewId)).toBe(true);
  });

  it("retries failed channels without resending successful channels", async () => {
    const email = vi.fn(async (_env: Env, address: string) => { if (address === "reviewer@example.com" && email.mock.calls.length <= 2) throw new Error("Temporary mail failure"); });
    await expect(deliverAcceptanceNotifications(event, env, email)).rejects.toThrow("retry");
    await deliverAcceptanceNotifications(event, env, email);
    expect(inbox).toHaveBeenCalledTimes(2);
    expect(email).toHaveBeenCalledTimes(3);
  });

  it("ignores obsolete states instead of resurrecting an old pending review", async () => {
    readReview.mockResolvedValue({ ...review, state: "superseded" });
    const email = vi.fn(async () => {});
    await deliverAcceptanceNotifications(event, env, email);
    expect(email).not.toHaveBeenCalled();
    expect(inbox).not.toHaveBeenCalled();
  });

  it("does not allow mail header injection", () => {
    expect(() => acceptanceMail("attacker@example.com\r\nBcc: other@example.com", "Review", "body", "id")).toThrow();
    expect(acceptanceMail("reviewer@example.com", "Review\r\nBcc: other@example.com", "body", "id")).not.toContain("\r\nBcc:");
  });
});
