import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifiedAccount: vi.fn(), access: vi.fn(), settings: vi.fn(), eligible: vi.fn(),
  automation: vi.fn(), teams: vi.fn(), integrations: vi.fn(), jwks: vi.fn(),
  providerFresh: vi.fn(), recordProvider: vi.fn(),
}));
vi.mock("../account-auth", () => ({ verifiedAccount: mocks.verifiedAccount }));
vi.mock("./teams", () => ({
  getProjectAccess: mocks.access, getProjectSettings: mocks.settings,
  listEligibleReviewers: mocks.eligible, authenticateAutomation: mocks.automation,
  handleTeamRoutes: mocks.teams,
}));
vi.mock("./integrations", () => ({ handleIntegrationRoutes: mocks.integrations, authenticateGithubWorkflow: async () => null, assertGithubPublication: async () => {}, assertGithubVerification: async () => {}, refreshGitHubChecksForReview: async () => {} }));
vi.mock("./receipts", () => ({ acceptanceJwksResponse: mocks.jwks }));
vi.mock("./pages", () => ({ acceptancePage: () => new Response("page") }));
vi.mock("./metrics", () => ({ recordAcceptanceMetric: async () => ({ inserted: true }), readProjectMetrics: async () => ({}) }));
vi.mock("./provider-verification", () => ({ hasFreshProviderVerification: mocks.providerFresh, recordProviderVerification: mocks.recordProvider }));

import { handleAcceptanceRequest } from "./api";

const projectId = "11111111-1111-4111-8111-111111111111";
const reviewId = "22222222-2222-4222-8222-222222222222";
const base = `https://nib.test/api/acceptance/v1/projects/${projectId}`;
const account = { id: "alice", email: "alice@example.com" };
const access = {
  projectId, teamId: "team", role: "reviewer",
  permissions: { read: true, publish: false, review: true, manage: false },
  policy: { quorum: 1, ttlSeconds: 604800 }, publicRead: false, enabled: true,
};
const review = {
  id: reviewId, projectId, subject: "pr:7", gate: "acceptance", state: "pending", revision: 1,
  manifestHash: "a".repeat(64), eligibleReviewers: ["alice", "bob"],
  manifest: { title: "Correct account state", criteria: [{ id: "c1", text: "Account status is correct" }], evidence: [] },
  votes: [], comments: [], receipt: null,
};
const coordinator = {
  getReview: vi.fn(), listReviews: vi.fn(), getCurrent: vi.fn(), publish: vi.fn(),
  decide: vi.fn(), comment: vi.fn(), openPreview: vi.fn(), invalidate: vi.fn(), verify: vi.fn(),
};
const env = {
  ACCEPTANCE_ENABLED: "true", DB: {}, PUBLIC_ORIGIN: "https://nib.test",
  ACCEPTANCE: { idFromName: vi.fn((id) => id), get: vi.fn(() => coordinator) },
} as unknown as Parameters<typeof handleAcceptanceRequest>[1];

function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`${base}${path}`, {
    method, headers: { "content-type": "application/json", "idempotency-key": "test-operation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifiedAccount.mockResolvedValue(account);
  mocks.access.mockResolvedValue(access);
  mocks.settings.mockResolvedValue({ id: projectId, publicRead: false, enabled: true, quorum: 1, ttlSeconds: 604800 });
  mocks.eligible.mockResolvedValue(["alice", "bob"]);
  mocks.automation.mockResolvedValue(null);
  mocks.teams.mockResolvedValue(null);
  mocks.integrations.mockResolvedValue(null);
  mocks.providerFresh.mockResolvedValue(true);
  mocks.recordProvider.mockResolvedValue(undefined);
  coordinator.getReview.mockResolvedValue(review);
  coordinator.decide.mockResolvedValue({ ...review, state: "approved" });
  coordinator.verify.mockResolvedValue({ satisfied: true, state: "approved", reviewId, manifestHash: review.manifestHash });
});

describe("acceptance API authorization", () => {
  const pilot = { ...env, ACCEPTANCE_PILOT_ACCOUNT_IDS: "alice", ACCEPTANCE_PILOT_PROJECT_IDS: projectId };

  it("denies unlisted accounts before team or integration handlers run", async () => {
    mocks.verifiedAccount.mockResolvedValue({ id: "bob", email: "bob@example.com" });
    for (const path of ["/acceptance", "/api/acceptance/v1/teams", `${new URL(base).pathname}/integrations/github`]) {
      expect((await handleAcceptanceRequest(new Request(`https://nib.test${path}`), pilot))?.status).toBe(403);
    }
    expect(mocks.integrations).not.toHaveBeenCalled();
    expect(mocks.teams).not.toHaveBeenCalled();
  });

  it("requires both pilot lists and denies unlisted projects before integrations", async () => {
    for (const config of [{ ...pilot, ACCEPTANCE_PILOT_PROJECT_IDS: "" }, { ...env, ACCEPTANCE_PILOT_ACCOUNT_IDS: "alice" }]) {
      expect((await handleAcceptanceRequest(request(`/reviews/${reviewId}`), config))?.status).toBe(403);
      expect((await handleAcceptanceRequest(request("/integrations/github"), config))?.status).toBe(403);
    }
    expect(coordinator.getReview).not.toHaveBeenCalled();
    expect(mocks.integrations).not.toHaveBeenCalled();
  });

  it("does not expose public review or evidence links during the pilot", async () => {
    mocks.verifiedAccount.mockResolvedValue(null);
    mocks.settings.mockResolvedValue({ id: projectId, publicRead: true, enabled: true });
    expect((await handleAcceptanceRequest(request(`/reviews/${reviewId}`), pilot))?.status).toBe(401);
    expect((await handleAcceptanceRequest(request("/evidence/example"), pilot))?.status).toBe(401);
    expect((await handleAcceptanceRequest(new Request(`https://nib.test/acceptance/projects/${projectId}/reviews/${reviewId}`), pilot))?.status).toBe(302);
    expect(coordinator.getReview).not.toHaveBeenCalled();
  });

  it("retains RBAC and filters vote eligibility to pilot accounts", async () => {
    expect((await handleAcceptanceRequest(request(`/reviews/${reviewId}/decisions`, { decision: "approve", criteriaIds: ["c1"] }), pilot))?.status).toBe(200);
    expect(coordinator.decide).toHaveBeenCalledWith(reviewId, expect.anything(), { actorId: "alice", eligibleReviewers: ["alice"] }, "test-operation");
    mocks.access.mockResolvedValue({ ...access, permissions: { ...access.permissions, review: false } });
    expect((await handleAcceptanceRequest(request(`/reviews/${reviewId}/decisions`, { decision: "approve", criteriaIds: ["c1"] }), pilot))?.status).toBe(403);
  });

  it("allows scoped automation only inside listed projects", async () => {
    mocks.verifiedAccount.mockResolvedValue(null);
    mocks.automation.mockResolvedValue({ id: "bot", projectId, scopes: ["read"] });
    const req = request(`/reviews/${reviewId}`);
    req.headers.set("authorization", "Bearer project-token");
    expect((await handleAcceptanceRequest(req, pilot))?.status).toBe(200);
    expect((await handleAcceptanceRequest(req, { ...pilot, ACCEPTANCE_PILOT_PROJECT_IDS: "other" }))?.status).toBe(403);
  });

  it("does not allow caller headers to impersonate a project reviewer", async () => {
    mocks.verifiedAccount.mockResolvedValue(null);
    const req = request(`/reviews/${reviewId}/decisions`, { decision: "approve", criteriaIds: ["c1"] });
    req.headers.set("x-nib-account-id", "alice");
    req.headers.set("x-nib-authz", JSON.stringify(access));
    const response = await handleAcceptanceRequest(req, env);
    expect(response?.status).toBe(401);
    expect(coordinator.decide).not.toHaveBeenCalled();
  });

  it("denies viewers decisions even when they can read a project", async () => {
    mocks.access.mockResolvedValue({ ...access, role: "viewer", permissions: { read: true, review: false, manage: false, publish: false } });
    expect((await handleAcceptanceRequest(request(`/reviews/${reviewId}/decisions`, { decision: "approve", criteriaIds: ["c1"] }), env))?.status).toBe(403);
    expect(coordinator.decide).not.toHaveBeenCalled();
  });

  it("passes server-authenticated identity and live eligibility to the coordinator", async () => {
    const response = await handleAcceptanceRequest(request(`/reviews/${reviewId}/decisions`, {
      decision: "approve", criteriaIds: ["c1"], actorId: "bob", eligibleReviewers: ["mallory"],
    }), env);
    expect(response?.status).toBe(200);
    expect(coordinator.decide).toHaveBeenCalledWith(reviewId,
      { decision: "approve", criteriaIds: ["c1"], comment: undefined },
      { actorId: "alice", eligibleReviewers: ["alice", "bob"] }, "test-operation");
  });

  it("requires idempotency for decisions before invoking the coordinator", async () => {
    const req = request(`/reviews/${reviewId}/decisions`, { decision: "approve", criteriaIds: ["c1"] });
    req.headers.delete("idempotency-key");
    expect((await handleAcceptanceRequest(req, env))?.status).toBe(400);
    expect(coordinator.decide).not.toHaveBeenCalled();
  });

  it("does not permit automation identities to vote", async () => {
    mocks.verifiedAccount.mockResolvedValue(null);
    mocks.automation.mockResolvedValue({ id: "bot", projectId, scopes: ["publish", "read", "verify"] });
    const req = request(`/reviews/${reviewId}/decisions`, { decision: "approve", criteriaIds: ["c1"] });
    req.headers.set("authorization", "Bearer project-token");
    expect((await handleAcceptanceRequest(req, env))?.status).toBe(403);
    expect(coordinator.decide).not.toHaveBeenCalled();
  });

  it("does not authorize a project credential on a different project", async () => {
    mocks.verifiedAccount.mockResolvedValue(null);
    mocks.automation.mockResolvedValue({ id: "bot", projectId: "other-project", scopes: ["read"] });
    const req = request(`/reviews/${reviewId}`);
    req.headers.set("authorization", "Bearer project-token");
    expect((await handleAcceptanceRequest(req, env))?.status).toBe(403);
    expect(coordinator.getReview).not.toHaveBeenCalled();
  });

  it("public read strips identities, private discussion, and the usable receipt", async () => {
    mocks.verifiedAccount.mockResolvedValue(null);
    mocks.settings.mockResolvedValue({ id: projectId, publicRead: true, enabled: true });
    coordinator.getReview.mockResolvedValue({ ...review, votes: [{ actorId: "alice", decision: "approve" }], comments: [{ actorId: "alice", text: "private" }], receipt: "signed-receipt" });
    const response = await handleAcceptanceRequest(request(`/reviews/${reviewId}`), env);
    expect(response?.status).toBe(200);
    const json = await response!.json() as Record<string, unknown>;
    expect(json).not.toHaveProperty("eligibleReviewers");
    expect(json).not.toHaveProperty("receipt");
    expect(JSON.stringify(json)).not.toContain("alice");
    expect(JSON.stringify(json)).not.toContain("private");
    expect(json.readOnly).toBe(true);
  });

  it("disabled acceptance fails a configured gate closed", async () => {
    const response = await handleAcceptanceRequest(request(`/reviews/${reviewId}/verify`, { manifestHash: review.manifestHash }), { ...env, ACCEPTANCE_ENABLED: "false" });
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({ satisfied: false });
    expect(coordinator.verify).not.toHaveBeenCalled();
  });

  it("keeps signed GitHub lifecycle processing available while acceptance is disabled", async () => {
    mocks.integrations.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const req = new Request("https://nib.test/api/acceptance/v1/github/webhook", { method: "POST", body: "{}" });
    const pausedEnv = { ...env, ACCEPTANCE_ENABLED: "false" };
    expect((await handleAcceptanceRequest(req, pausedEnv))?.status).toBe(200);
    expect(mocks.integrations).toHaveBeenCalledWith(req, pausedEnv, null);
    expect(mocks.verifiedAccount).not.toHaveBeenCalled();
    expect(coordinator.verify).not.toHaveBeenCalled();
  });

  it("preserves webhook signature rejection during the pause and does not open token exchange", async () => {
    mocks.integrations.mockResolvedValue(new Response("invalid signature", { status: 401 }));
    const pausedEnv = { ...env, ACCEPTANCE_ENABLED: "false" };
    expect((await handleAcceptanceRequest(new Request("https://nib.test/api/acceptance/v1/github/webhook", { method: "POST", body: "{}" }), pausedEnv))?.status).toBe(401);
    mocks.integrations.mockClear();
    expect((await handleAcceptanceRequest(new Request("https://nib.test/api/acceptance/v1/github/token", { method: "POST", body: "{}" }), pausedEnv))?.status).toBe(503);
    expect(mocks.integrations).not.toHaveBeenCalled();
  });

  it("refuses a current approval when its provider version check is missing", async () => {
    mocks.providerFresh.mockResolvedValue(false);
    const response = await handleAcceptanceRequest(request(`/reviews/${reviewId}/verify`, { manifestHash: review.manifestHash }), env);
    expect(await response!.json()).toMatchObject({ satisfied: false, reason: "cloudflare_current_version_unverified" });
  });

  it("rechecks canonical state after the provider query so supersession cannot reuse the earlier verdict", async () => {
    coordinator.verify.mockResolvedValueOnce({ satisfied: true, manifestHash: review.manifestHash })
      .mockResolvedValueOnce({ satisfied: false, state: "superseded", reason: "not_current" });
    const response = await handleAcceptanceRequest(request(`/reviews/${reviewId}/verify`, { manifestHash: review.manifestHash }), env);
    expect(await response!.json()).toMatchObject({ satisfied: false, state: "superseded" });
    expect(coordinator.verify).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-origin cookie-authenticated mutations", async () => {
    const req = request(`/reviews/${reviewId}/comments`, { text: "Change this" });
    req.headers.set("origin", "https://evil.example");
    expect((await handleAcceptanceRequest(req, env))?.status).toBe(403);
    expect(coordinator.comment).not.toHaveBeenCalled();
  });
});
