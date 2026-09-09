import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from "jose";
import { hmacSha256Hex, sha256Hex } from "./common";
import { parseAcceptanceError } from "./contracts";
import { validateGitHubWorkflowClaims } from "./github";
import type { AcceptanceChangedEvent, AcceptanceIntegrationEnv } from "./integrations";
import { assertGithubPublication, authenticateGithubWorkflow, deliverAcceptanceEvent, handleIntegrationRoutes, reconcileGitHubAcceptanceChecks, refreshGitHubChecksForReview } from "./integrations";
import { createAcceptanceTeamTestFixture, type AcceptanceTeamTestFixture } from "./team-test-db";

const projectId = "11111111-1111-4111-8111-111111111111";
const owner = { id: "account-owner", email: "owner@example.test" };
const sqliteFixtures: AcceptanceTeamTestFixture[] = [];

describe("acceptance integrations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const fixture of sqliteFixtures.splice(0)) fixture.sqlite.close();
  });

  it("rejects GitHub webhooks before DB writes when the HMAC signature is invalid", async () => {
    const db = new FakeD1();
    const response = await handleIntegrationRoutes(
      new Request("https://nib.test/api/acceptance/v1/github/webhook", {
        method: "POST",
        headers: {
          "x-github-delivery": "delivery-1",
          "x-github-event": "pull_request",
          "x-hub-signature-256": "sha256=bad",
        },
        body: JSON.stringify({ action: "opened" }),
      }),
      { DB: db as unknown as D1Database, PUBLIC_ORIGIN: "https://nib.test", GITHUB_WEBHOOK_SECRET: "secret" },
      null,
    );

    expect(response?.status).toBe(401);
    expect(db.statements).toHaveLength(0);
  });

  it("acknowledges replayed GitHub delivery ids without processing them twice", async () => {
    const payload = JSON.stringify({
      action: "opened",
      repository: { id: 123, name: "example", owner: { login: "nib" } },
      pull_request: { number: 12, head: { sha: "abc123" } },
    });
    const signature = `sha256=${await hmacSha256Hex("secret", payload)}`;
    const db = new FakeD1();
    db.githubDeliveryInsertChanges = [1, 0];

    const request = () => new Request("https://nib.test/api/acceptance/v1/github/webhook", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const env = { DB: db as unknown as D1Database, PUBLIC_ORIGIN: "https://nib.test", GITHUB_WEBHOOK_SECRET: "secret" };
    expect((await handleIntegrationRoutes(request(), env, null))?.status).toBe(200);
    const replay = await handleIntegrationRoutes(request(), env, null);

    expect(replay?.status).toBe(200);
    await expect(replay?.json()).resolves.toMatchObject({ replayed: true });
    expect(db.statements.filter((sql) => sql.includes("INSERT INTO acceptance_github_pull_heads"))).toHaveLength(1);
  });

  it("returns 503 for a GitHub delivery that is actively processing", async () => {
    const f = await sqliteFixture();
    const payload = pullRequestPayload("abc123");
    const signature = `sha256=${await hmacSha256Hex("secret", payload)}`;
    f.sqlite.prepare(
      `INSERT INTO acceptance_github_webhook_deliveries(
         id, event_name, payload_json, state, received_at, processing_started_at
       ) VALUES (?, 'pull_request', ?, 'processing', unixepoch(), unixepoch())`,
    ).run("delivery-busy", payload);

    const response = await handleIntegrationRoutes(githubWebhookRequest("delivery-busy", payload, signature), {
      ...f.env,
      GITHUB_WEBHOOK_SECRET: "secret",
    }, null);

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "webhook_delivery_in_progress" } });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_github_pull_heads").get()?.count).toBe(0);
  });

  it("retries a failed GitHub delivery replay and records the pull head", async () => {
    const f = await sqliteFixture();
    const payload = pullRequestPayload("abc123");
    const signature = `sha256=${await hmacSha256Hex("secret", payload)}`;
    const env = { ...f.env, GITHUB_WEBHOOK_SECRET: "secret" };
    f.sqlite.exec(
      "CREATE TRIGGER fail_pull_head_insert BEFORE INSERT ON acceptance_github_pull_heads BEGIN SELECT RAISE(ABORT, 'pull head unavailable'); END",
    );

    await expect(handleIntegrationRoutes(githubWebhookRequest("delivery-failed", payload, signature), env, null))
      .rejects.toThrow("pull head unavailable");
    expect(f.sqlite.prepare("SELECT state FROM acceptance_github_webhook_deliveries WHERE id = ?").get("delivery-failed")?.state)
      .toBe("failed");
    f.sqlite.exec("DROP TRIGGER fail_pull_head_insert");

    const replay = await handleIntegrationRoutes(githubWebhookRequest("delivery-failed", payload, signature), env, null);

    expect(replay?.status).toBe(200);
    expect(f.sqlite.prepare("SELECT state FROM acceptance_github_webhook_deliveries WHERE id = ?").get("delivery-failed")?.state)
      .toBe("processed");
    expect(f.sqlite.prepare("SELECT head_sha FROM acceptance_github_pull_heads WHERE repository_id = ? AND pull_number = ?").get("123", "12")?.head_sha)
      .toBe("abc123");
  });

  it("reclaims a stale GitHub delivery lease and processes the stored payload", async () => {
    const f = await sqliteFixture();
    const payload = pullRequestPayload("def456");
    const signature = `sha256=${await hmacSha256Hex("secret", payload)}`;
    f.sqlite.prepare(
      `INSERT INTO acceptance_github_webhook_deliveries(
         id, event_name, payload_json, state, received_at, processing_started_at
       ) VALUES (?, 'pull_request', ?, 'processing', 1, 1)`,
    ).run("delivery-stale", payload);

    const response = await handleIntegrationRoutes(githubWebhookRequest("delivery-stale", payload, signature), {
      ...f.env,
      GITHUB_WEBHOOK_SECRET: "secret",
    }, null);

    expect(response?.status).toBe(200);
    expect(f.sqlite.prepare("SELECT state FROM acceptance_github_webhook_deliveries WHERE id = ?").get("delivery-stale")?.state)
      .toBe("processed");
    expect(f.sqlite.prepare("SELECT head_sha FROM acceptance_github_pull_heads WHERE repository_id = ? AND pull_number = ?").get("123", "12")?.head_sha)
      .toBe("def456");
  });

  it("invalidates a current PR review when its manifest commit differs from the incoming GitHub head", async () => {
    const f = await sqliteFixture();
    installGitHubRepository(f);
    f.sqlite.prepare(
      "INSERT INTO acceptance_github_pull_heads(repository_id, pull_number, head_sha, subject, updated_at) VALUES (?, ?, ?, ?, 1)",
    ).run("123", "12", "def456", "github:nib/example:pull/12");
    const current = approvedEvent();
    current.manifest.build.commit = "abc123";
    const invalidate = vi.fn(async () => undefined);
    const payload = pullRequestPayload("def456");
    const signature = `sha256=${await hmacSha256Hex("secret", payload)}`;

    const response = await handleIntegrationRoutes(githubWebhookRequest("delivery-invalidate", payload, signature), {
      ...f.env,
      GITHUB_WEBHOOK_SECRET: "secret",
      ACCEPTANCE: currentReviewCoordinator(current, invalidate),
    }, null);

    expect(response?.status).toBe(200);
    expect(invalidate).toHaveBeenCalledWith(
      current.reviewId,
      "GitHub pull request head changed.",
      "github:webhook",
      `github:pr-head:123:12:acceptance:${current.reviewId}`,
    );
  });

  it("does not publish a GitHub check when the coordinator current state moved past the event", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const db = new FakeD1();
    db.integrationEventChanges = [1];
    const env = {
      DB: db as unknown as D1Database,
      PUBLIC_ORIGIN: "https://nib.test",
      ACCEPTANCE: staleCoordinator(),
    } as unknown as AcceptanceIntegrationEnv;

    await deliverAcceptanceEvent(approvedEvent(), env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.statements.some((sql) => sql.includes("acceptance_github_check_runs"))).toBe(false);
  });

  it("delivers signed customer webhooks with per-project sequence history", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://cloudflare-dns.com") {
        return Response.json({ Answer: [{ data: "93.184.216.34" }] });
      }
      if (init?.method === "HEAD") return new Response(null, { status: 204 });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const db = new FakeD1();
    db.integrationEventChanges = [1];
    db.webhookEndpoints = [{
      id: "webhook-1",
      project_id: projectId,
      url: "https://customer.test/hook",
      description: null,
      secret: "whsec_test",
      events_json: JSON.stringify(["acceptance.changed"]),
      enabled: 1,
      created_at: 1,
      updated_at: 1,
    }];

    await deliverAcceptanceEvent(approvedEvent(), {
      DB: db as unknown as D1Database,
      PUBLIC_ORIGIN: "https://nib.test",
    });

    const postCalls = fetchMock.mock.calls.filter((call) => String(call[0]) === "https://customer.test/hook" && call[1]?.method === "POST");
    expect(postCalls).toHaveLength(1);
    const call = postCalls[0];
    expect(call).toBeDefined();
    const request = call![1] as RequestInit;
    const headers = request.headers as Record<string, string>;
    expect(headers["x-nib-sequence"]).toBe("1");
    expect(headers["x-nib-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(db.batchCalls).toBe(1);
  });

  it("retries an unfinished sink when a duplicate canonical event is delivered", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://cloudflare-dns.com") {
        return Response.json({ Answer: [{ data: "93.184.216.34" }] });
      }
      if (init?.method === "HEAD") return new Response(null, { status: 204 });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const db = new FakeD1();
    db.integrationEventChanges = [1, 0];
    db.failWebhookEndpointQueryOnce = true;
    db.webhookEndpoints = [{
      id: "webhook-1",
      project_id: projectId,
      url: "https://customer.test/hook",
      description: null,
      secret: "whsec_test",
      events_json: JSON.stringify(["acceptance.changed"]),
      enabled: 1,
      created_at: 1,
      updated_at: 1,
    }];
    const env = {
      DB: db as unknown as D1Database,
      PUBLIC_ORIGIN: "https://nib.test",
    };

    await expect(deliverAcceptanceEvent(approvedEvent(), env)).rejects.toThrow("endpoint query failed");
    await deliverAcceptanceEvent(approvedEvent(), env);

    const postCalls = fetchMock.mock.calls.filter((call) => String(call[0]) === "https://customer.test/hook" && call[1]?.method === "POST");
    expect(postCalls).toHaveLength(1);
    expect(db.sinkStates.get("event-1:webhooks")).toBe("done");
  });

  it("retries unfinished sinks against the migrated SQLite schema", async () => {
    const f = await sqliteFixture();
    const create = await handleIntegrationRoutes(
      new Request(`https://nib.test/api/acceptance/v1/projects/${projectId}/integrations/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "create-webhook" },
        body: JSON.stringify({ url: "https://example.com/hook", events: ["acceptance.changed"] }),
      }),
      f.env,
      { ...owner, sessionId: "session", sessionName: "owner", platform: "web" },
    );
    expect(create?.status).toBe(201);
    f.sqlite.exec(
      "CREATE TRIGGER fail_delivery_insert BEFORE INSERT ON acceptance_webhook_deliveries BEGIN SELECT RAISE(ABORT, 'delivery storage unavailable'); END",
    );
    await expect(deliverAcceptanceEvent(approvedEvent(), f.env)).rejects.toThrow("delivery storage unavailable");
    f.sqlite.exec("DROP TRIGGER fail_delivery_insert");

    await deliverAcceptanceEvent(approvedEvent(), f.env);

    const deliveryCalls = f.fetch.mock.calls.filter((call) => String(call[0]) === "https://example.com/hook" && call[1]?.method === "POST");
    expect(deliveryCalls).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_integration_events WHERE id = ?").get("event-1")?.count).toBe(1);
    expect(f.sqlite.prepare("SELECT state FROM acceptance_integration_event_sinks WHERE event_id = ? AND sink = 'webhooks'")
      .get("event-1")?.state).toBe("done");
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_webhook_deliveries").get()?.count).toBe(1);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_webhook_attempts").get()?.count).toBe(1);
  });

  it("replays webhook creation idempotently against migrated SQLite", async () => {
    const f = await sqliteFixture();
    const request = () => new Request(`https://nib.test/api/acceptance/v1/projects/${projectId}/integrations/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "same-webhook" },
      body: JSON.stringify({ url: "https://example.com/hook", events: ["acceptance.changed"] }),
    });

    const first = await handleIntegrationRoutes(request(), f.env, { ...owner, sessionId: "session", sessionName: "owner", platform: "web" });
    const second = await handleIntegrationRoutes(request(), f.env, { ...owner, sessionId: "session", sessionName: "owner", platform: "web" });
    const firstBody = await first?.json() as { webhook: { signingSecret: string } };
    const secondBody = await second?.json() as { webhook: { signingSecret: string } };

    expect(first?.status).toBe(201);
    expect(second?.status).toBe(201);
    expect(secondBody.webhook.signingSecret).toBe(firstBody.webhook.signingSecret);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_webhook_endpoints").get()?.count).toBe(1);
  });

  it("rejects private webhook endpoint URLs before storage", async () => {
    const f = await sqliteFixture();
    const response = await handleIntegrationRoutes(
      new Request(`https://nib.test/api/acceptance/v1/projects/${projectId}/integrations/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "private-webhook" },
        body: JSON.stringify({ url: "https://127.0.0.1/hook" }),
      }),
      f.env,
      { ...owner, sessionId: "session", sessionName: "owner", platform: "web" },
    );

    expect(response?.status).toBe(400);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_webhook_endpoints").get()?.count).toBe(0);
  });


  it("rolls back webhook create idempotency when the endpoint insert fails", async () => {
    const f = await sqliteFixture();
    f.sqlite.exec(
      "CREATE TRIGGER fail_endpoint_insert BEFORE INSERT ON acceptance_webhook_endpoints BEGIN SELECT RAISE(ABORT, 'endpoint insert failed'); END",
    );
    const request = () => new Request(`https://nib.test/api/acceptance/v1/projects/${projectId}/integrations/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "crash-window" },
      body: JSON.stringify({ url: "https://example.com/hook", events: ["acceptance.changed"] }),
    });

    await expect(handleIntegrationRoutes(
      request(),
      f.env,
      { ...owner, sessionId: "session", sessionName: "owner", platform: "web" },
    )).rejects.toThrow("endpoint insert failed");
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_integration_idempotency WHERE idempotency_key = ?").get("crash-window")?.count).toBe(0);

    f.sqlite.exec("DROP TRIGGER fail_endpoint_insert");
    const retry = await handleIntegrationRoutes(
      request(),
      f.env,
      { ...owner, sessionId: "session", sessionName: "owner", platform: "web" },
    );

    expect(retry?.status).toBe(201);
    expect(f.sqlite.prepare("SELECT state FROM acceptance_integration_idempotency WHERE idempotency_key = ?").get("crash-window")?.state).toBe("done");
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_webhook_endpoints").get()?.count).toBe(1);
  });

  it("serializes concurrent identical webhook creates against migrated SQLite", async () => {
    const f = await sqliteFixture();
    const request = () => new Request(`https://nib.test/api/acceptance/v1/projects/${projectId}/integrations/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "concurrent-create" },
      body: JSON.stringify({ url: "https://example.com/hook", events: ["acceptance.changed"] }),
    });

    const [first, second] = await Promise.all([
      handleIntegrationRoutes(request(), f.env, { ...owner, sessionId: "session", sessionName: "owner", platform: "web" }),
      handleIntegrationRoutes(request(), f.env, { ...owner, sessionId: "session", sessionName: "owner", platform: "web" }),
    ]);
    const firstBody = await first?.json() as { webhook: { id: string; signingSecret: string } };
    const secondBody = await second?.json() as { webhook: { id: string; signingSecret: string } };

    expect(first?.status).toBe(201);
    expect(second?.status).toBe(201);
    expect(secondBody.webhook).toEqual(firstBody.webhook);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_webhook_endpoints").get()?.count).toBe(1);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_integration_idempotency WHERE idempotency_key = ?").get("concurrent-create")?.count).toBe(1);
  });

  it("revalidates webhook URLs before delivery without sending payload secrets to redirected endpoints", async () => {
    const f = await sqliteFixture();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://cloudflare-dns.com") {
        return Response.json({ Answer: [{ data: "93.184.216.34" }] });
      }
      if (init?.method === "HEAD") return new Response(null, { status: 302, headers: { location: "https://other.example/hook" } });
      if (init?.method === "POST") throw new Error("POST should not be sent after redirect revalidation");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    f.sqlite.prepare(
      `INSERT INTO acceptance_webhook_endpoints(
         id, project_id, url, description, secret, events_json, enabled, created_by_account_id, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, 1, 1)`,
    ).run("webhook-redirect", projectId, "https://example.com/hook", "whsec_test", JSON.stringify(["acceptance.changed"]), owner.id);

    await deliverAcceptanceEvent(approvedEvent(), f.env);

    const customerCalls = fetchMock.mock.calls.filter((call) => String(call[0]) === "https://example.com/hook");
    expect(customerCalls.map((call) => call[1]?.method)).toEqual(["HEAD"]);
    expect(customerCalls[0]?.[1]?.headers ?? {}).not.toHaveProperty("x-nib-signature");
    expect(f.sqlite.prepare("SELECT state, last_status FROM acceptance_webhook_deliveries").get()).toMatchObject({ state: "retry", last_status: 0 });
    expect(f.sqlite.prepare("SELECT status, response_body FROM acceptance_webhook_attempts").get()).toMatchObject({
      status: 0,
      response_body: "Webhook URL is no longer a public HTTPS endpoint without redirects.",
    });
  });

  it("rejects issued GitHub workflow tokens after config unlink or allowlist narrowing", async () => {
    const f = await sqliteFixture();
    installGitHubRepository(f);
    await insertGitHubWorkflowToken(f, { token: "workflow-token" });

    await expect(authenticateGithubWorkflow(f.env.DB, "Bearer workflow-token")).resolves.toMatchObject({ repositoryId: "123" });
    const deleted = await handleIntegrationRoutes(
      new Request(`https://nib.test/api/acceptance/v1/projects/${projectId}/integrations/github?repository_id=123`, {
        method: "DELETE",
        headers: { "idempotency-key": "delete-github-123" },
      }),
      f.env,
      { ...owner, sessionId: "session", sessionName: "owner", platform: "web" },
    );
    expect(deleted?.status).toBe(200);
    await expect(authenticateGithubWorkflow(f.env.DB, "Bearer workflow-token")).resolves.toBeNull();
    expect(f.sqlite.prepare("SELECT revoked_at FROM acceptance_github_workflow_tokens WHERE token_hash = ?")
      .get(await sha256Hex("workflow-token"))?.revoked_at).toBeGreaterThan(0);

    f.sqlite.prepare("UPDATE acceptance_github_installations SET enabled = 1, allowed_workflows_json = ? WHERE repository_id = ?")
      .run(JSON.stringify(["nib/example/.github/workflows/other.yml@refs/heads/main"]), "123");
    await insertGitHubWorkflowToken(f, { token: "workflow-token-2" });
    await expect(authenticateGithubWorkflow(f.env.DB, "Bearer workflow-token-2")).resolves.toBeNull();
  });

  it("revokes mapped GitHub workflow tokens on signed installation suspend webhooks", async () => {
    const f = await sqliteFixture();
    installGitHubRepository(f);
    await insertGitHubWorkflowToken(f, { token: "workflow-token" });
    const payload = JSON.stringify({ action: "suspend", installation: { id: 456 } });
    const signature = `sha256=${await hmacSha256Hex("secret", payload)}`;

    const response = await handleIntegrationRoutes(githubWebhookRequest("delivery-suspend", payload, signature, "installation"), {
      ...f.env,
      GITHUB_WEBHOOK_SECRET: "secret",
    }, null);

    expect(response?.status).toBe(200);
    expect(f.sqlite.prepare("SELECT enabled FROM acceptance_github_installations WHERE repository_id = ?").get("123")?.enabled).toBe(0);
    expect(f.sqlite.prepare("SELECT revoked_at FROM acceptance_github_workflow_tokens WHERE token_hash = ?")
      .get(await sha256Hex("workflow-token"))?.revoked_at).toBeGreaterThan(0);
    await expect(authenticateGithubWorkflow(f.env.DB, "Bearer workflow-token")).resolves.toBeNull();
  });

  it("revokes only current matching installation repository tokens for signed installation_repositories webhooks", async () => {
    const f = await sqliteFixture();
    installGitHubRepository(f);
    installGitHubRepository(f, {
      id: "github-installation-other",
      repositoryId: "999",
      owner: "nib",
      name: "other",
      workflowRef: "nib/other/.github/workflows/acceptance.yml@refs/heads/main",
    });
    await insertGitHubWorkflowToken(f, { token: "removed-token" });
    await insertGitHubWorkflowToken(f, {
      token: "kept-token",
      repositoryId: "999",
      repository: "nib/other",
      workflowRef: "nib/other/.github/workflows/acceptance.yml@refs/heads/main",
      actorId: "github:999:nib/other/.github/workflows/acceptance.yml@refs/heads/main",
    });
    const payload = JSON.stringify({
      action: "removed",
      installation: { id: 456 },
      repositories_removed: [{ id: 123, name: "example" }],
    });
    const signature = `sha256=${await hmacSha256Hex("secret", payload)}`;

    const response = await handleIntegrationRoutes(githubWebhookRequest("delivery-repo-removed", payload, signature, "installation_repositories"), {
      ...f.env,
      GITHUB_WEBHOOK_SECRET: "secret",
    }, null);

    expect(response?.status).toBe(200);
    expect(f.sqlite.prepare("SELECT enabled FROM acceptance_github_installations WHERE repository_id = ?").get("123")?.enabled).toBe(0);
    expect(f.sqlite.prepare("SELECT enabled FROM acceptance_github_installations WHERE repository_id = ?").get("999")?.enabled).toBe(1);
    await expect(authenticateGithubWorkflow(f.env.DB, "Bearer removed-token")).resolves.toBeNull();
    await expect(authenticateGithubWorkflow(f.env.DB, "Bearer kept-token")).resolves.toMatchObject({ repositoryId: "999" });
  });

  it("does not revoke replacement installation tokens when an old repository removal arrives", async () => {
    const f = await sqliteFixture();
    installGitHubRepository(f, { installationId: "789" });
    await insertGitHubWorkflowToken(f, { token: "replacement-token" });
    const payload = JSON.stringify({
      action: "removed",
      installation: { id: 456 },
      repositories_removed: [{ id: 123, name: "example" }],
    });
    const signature = `sha256=${await hmacSha256Hex("secret", payload)}`;

    const response = await handleIntegrationRoutes(githubWebhookRequest("delivery-old-repo-removed", payload, signature, "installation_repositories"), {
      ...f.env,
      GITHUB_WEBHOOK_SECRET: "secret",
    }, null);

    expect(response?.status).toBe(200);
    expect(f.sqlite.prepare("SELECT installation_id, enabled FROM acceptance_github_installations WHERE repository_id = ?")
      .get("123")).toMatchObject({ installation_id: "789", enabled: 1 });
    await expect(authenticateGithubWorkflow(f.env.DB, "Bearer replacement-token")).resolves.toMatchObject({ repositoryId: "123" });
    expect(f.sqlite.prepare("SELECT revoked_at FROM acceptance_github_workflow_tokens WHERE token_hash = ?")
      .get(await sha256Hex("replacement-token"))?.revoked_at).toBeNull();
  });

  it("links a GitHub installation only with signed default-branch repository ownership proof", async () => {
    const f = await sqliteFixture();
    const proof = await githubOidcFixture({ eventName: "push", ref: "refs/heads/main" });
    const appPrivateKey = await gitHubAppPrivateKey();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "token.actions.githubusercontent.com") return Response.json(proof.jwks);
      if (url.pathname === "/app/installations/456/access_tokens") return Response.json({ token: "installation-token", expires_at: "2026-09-09T04:00:00Z" });
      if (url.pathname === "/repositories/123") return Response.json({ id: 123, name: "example", default_branch: "main", owner: { login: "nib" } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleIntegrationRoutes(githubLinkRequest({ ownershipOidcToken: proof.token }), {
      ...f.env,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: appPrivateKey,
    }, { ...owner, sessionId: "session", sessionName: "owner", platform: "web" });

    expect(response?.status).toBe(200);
    expect(f.sqlite.prepare("SELECT repository_id, repository_owner, repository_name, allowed_workflows_json, enabled FROM acceptance_github_installations").get())
      .toMatchObject({ repository_id: "123", repository_owner: "nib", repository_name: "example", enabled: 1 });
    const stored = f.sqlite.prepare("SELECT allowed_workflows_json FROM acceptance_github_installations").get() as { allowed_workflows_json: string };
    expect(JSON.parse(stored.allowed_workflows_json)).toEqual(["nib/example/.github/workflows/acceptance.yml@refs/heads/main"]);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("token.actions.githubusercontent.com"))).toBe(true);
  });

  it("rejects GitHub installation linking without ownership proof before config mutation", async () => {
    const f = await sqliteFixture();

    const response = await handleIntegrationRoutes(githubLinkRequest({ ownershipOidcToken: undefined }), f.env, {
      ...owner,
      sessionId: "session",
      sessionName: "owner",
      platform: "web",
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "github_ownership_proof_required" } });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_github_installations").get()?.count).toBe(0);
  });

  it("rejects forged GitHub installation ownership proof without config mutation", async () => {
    const f = await sqliteFixture();
    const proof = await githubOidcFixture({ eventName: "push", ref: "refs/heads/main" });
    const appPrivateKey = await gitHubAppPrivateKey();
    vi.stubGlobal("fetch", githubLinkFetch(proof.jwks));

    const response = await handleIntegrationRoutes(githubLinkRequest({ ownershipOidcToken: "forged.token.value" }), {
      ...f.env,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: appPrivateKey,
    }, { ...owner, sessionId: "session", sessionName: "owner", platform: "web" });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "github_ownership_proof_invalid" } });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_github_installations").get()?.count).toBe(0);
  });

  it("rejects GitHub installation ownership proof from pull_request events without config mutation", async () => {
    const f = await sqliteFixture();
    const proof = await githubOidcFixture({ eventName: "pull_request", ref: "refs/heads/main" });
    const appPrivateKey = await gitHubAppPrivateKey();
    vi.stubGlobal("fetch", githubLinkFetch(proof.jwks));

    const response = await handleIntegrationRoutes(githubLinkRequest({ ownershipOidcToken: proof.token }), {
      ...f.env,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: appPrivateKey,
    }, { ...owner, sessionId: "session", sessionName: "owner", platform: "web" });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "github_ownership_proof_untrusted_event" } });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_github_installations").get()?.count).toBe(0);
  });

  it("rejects GitHub installation ownership proof from a different repository without config mutation", async () => {
    const f = await sqliteFixture();
    const proof = await githubOidcFixture({ repositoryId: "999", repository: "attacker/repo", eventName: "push", ref: "refs/heads/main" });
    const appPrivateKey = await gitHubAppPrivateKey();
    vi.stubGlobal("fetch", githubLinkFetch(proof.jwks));

    const response = await handleIntegrationRoutes(githubLinkRequest({ ownershipOidcToken: proof.token }), {
      ...f.env,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: appPrivateKey,
    }, { ...owner, sessionId: "session", sessionName: "owner", platform: "web" });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "github_ownership_proof_wrong_repository" } });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_github_installations").get()?.count).toBe(0);
  });

  it("rejects GitHub installation ownership proof from a non-default branch without config mutation", async () => {
    const f = await sqliteFixture();
    const proof = await githubOidcFixture({ eventName: "workflow_dispatch", ref: "refs/heads/feature", workflowRef: "nib/example/.github/workflows/acceptance.yml@refs/heads/feature" });
    const appPrivateKey = await gitHubAppPrivateKey();
    vi.stubGlobal("fetch", githubLinkFetch(proof.jwks));

    const response = await handleIntegrationRoutes(githubLinkRequest({ ownershipOidcToken: proof.token }), {
      ...f.env,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: appPrivateKey,
    }, { ...owner, sessionId: "session", sessionName: "owner", platform: "web" });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "github_ownership_proof_wrong_ref" } });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_github_installations").get()?.count).toBe(0);
  });

  it("rejects GitHub workflow tokens without valid SHA and ref claims", () => {
    expect(validateGitHubWorkflowClaims({
      repositoryId: "123",
      workflowRef: "nib/example/.github/workflows/acceptance.yml@refs/heads/main",
      repository: "nib/example",
      sha: null,
      ref: "refs/heads/main",
    })).toMatch(/valid workflow SHA/);
    expect(validateGitHubWorkflowClaims({
      repositoryId: "123",
      workflowRef: "nib/example/.github/workflows/acceptance.yml@refs/heads/main",
      repository: "nib/example",
      sha: "a".repeat(40),
      ref: "main",
    })).toMatch(/valid workflow ref/);
    expect(validateGitHubWorkflowClaims({
      repositoryId: "123",
      workflowRef: "nib/example/.github/workflows/acceptance.yml@refs/heads/main",
      repository: "nib/example",
      sha: "a".repeat(40),
      ref: "refs/heads/main",
    })).toBeNull();
  });

  it("reclaims crashed running event sinks and eventually delivers", async () => {
    const f = await sqliteFixture();
    f.sqlite.prepare(
      `INSERT INTO acceptance_webhook_endpoints(
         id, project_id, url, description, secret, events_json, enabled, created_by_account_id, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, 1, 1)`,
    ).run("webhook-stale", projectId, "https://example.com/hook", "whsec_test", JSON.stringify(["acceptance.changed"]), owner.id);
    const event = approvedEvent();
    f.sqlite.prepare(
      `INSERT INTO acceptance_integration_events(
         id, project_id, review_id, subject, gate, revision, sequence, state, manifest_hash, payload_json, occurred_at, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      event.id,
      event.projectId,
      event.reviewId,
      event.subject,
      event.gate,
      event.revision,
      event.sequence,
      event.state,
      event.manifestHash,
      JSON.stringify(event),
      event.occurredAt,
    );
    f.sqlite.prepare(
      "INSERT INTO acceptance_integration_event_sinks(event_id, sink, state, attempt_count, claimed_at, updated_at) VALUES (?, 'webhooks', 'running', 1, 1, 1)",
    ).run(event.id);

    await deliverAcceptanceEvent(event, f.env);

    const postCalls = f.fetch.mock.calls.filter((call) => String(call[0]) === "https://example.com/hook" && call[1]?.method === "POST");
    expect(postCalls).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT state, attempt_count FROM acceptance_integration_event_sinks WHERE event_id = ? AND sink = 'webhooks'").get("event-1"))
      .toMatchObject({ state: "done", attempt_count: 2 });
  });

  it("requires and replays GitHub workflow token idempotency after fresh OIDC verification", async () => {
    const f = await sqliteFixture();
    const oidc = await githubOidcFixture();
    installGitHubRepository(f);
    let jwksFetches = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "token.actions.githubusercontent.com") {
        jwksFetches += 1;
        return Response.json(oidc.jwks);
      }
      return new Response(null, { status: 204 });
    }));
    const request = () => new Request("https://nib.test/api/acceptance/v1/github/token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "oidc-token" },
      body: JSON.stringify({ oidcToken: oidc.token, projectId, mode: "verify" }),
    });

    const first = await handleIntegrationRoutes(request(), f.env, null);
    const second = await handleIntegrationRoutes(request(), f.env, null);
    const firstBody = await first?.json() as { access_token: string; scopes: string[] };
    const secondBody = await second?.json() as { access_token: string; scopes: string[] };

    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(secondBody.access_token).toBe(firstBody.access_token);
    expect(secondBody.scopes).toEqual(["verify"]);
    expect(jwksFetches).toBeGreaterThanOrEqual(2);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM acceptance_github_workflow_tokens").get()?.count).toBe(1);
  });

  it("rejects GitHub workflow token idempotency conflicts", async () => {
    const f = await sqliteFixture();
    const oidc = await githubOidcFixture();
    installGitHubRepository(f);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "token.actions.githubusercontent.com") return Response.json(oidc.jwks);
      return new Response(null, { status: 204 });
    }));

    const first = await handleIntegrationRoutes(new Request("https://nib.test/api/acceptance/v1/github/token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "oidc-conflict" },
      body: JSON.stringify({ oidcToken: oidc.token, projectId, mode: "verify" }),
    }), f.env, null);
    expect(first?.status).toBe(200);

    await expect(handleIntegrationRoutes(new Request("https://nib.test/api/acceptance/v1/github/token", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "oidc-conflict" },
      body: JSON.stringify({ oidcToken: oidc.token, projectId, mode: "publish" }),
    }), f.env, null)).rejects.toThrow("different request");
  });

  it("requires Idempotency-Key for GitHub workflow token exchange", async () => {
    const response = await handleIntegrationRoutes(new Request("https://nib.test/api/acceptance/v1/github/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oidcToken: "token", projectId, mode: "verify" }),
    }), { DB: new FakeD1() as unknown as D1Database, PUBLIC_ORIGIN: "https://nib.test" }, null);

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "idempotency_key_required" } });
  });

  it("publishes and reconciles non-success GitHub checks when an approved project is disabled", async () => {
    const f = await sqliteFixture();
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    installGitHubRepository(f);
    f.sqlite.prepare("UPDATE acceptance_projects SET enabled = 0 WHERE id = ?").run(projectId);
    const event = approvedEvent();
    let checkId = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/456/access_tokens") return Response.json({ token: "installation-token", expires_at: "2026-09-09T04:00:00Z" });
      if (url.pathname === "/repos/nib/example/check-runs" && init?.method === "POST") {
        checkId += 1;
        return Response.json({ id: checkId, html_url: `https://github.test/check/${checkId}` });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      ...f.env,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: await exportPKCS8(privateKey),
      GITHUB_API_URL: "https://github.test",
      ACCEPTANCE: currentReviewCoordinator(event),
    };

    await deliverAcceptanceEvent(event, env);
    expect(f.sqlite.prepare("SELECT conclusion, check_run_id FROM acceptance_github_check_runs WHERE config_id = ? AND event_id = ?")
      .get("github-installation", event.id)).toMatchObject({ conclusion: "failure", check_run_id: "1" });

    f.sqlite.prepare("UPDATE acceptance_github_check_runs SET conclusion = 'success', check_run_id = 'stale-success' WHERE config_id = ? AND event_id = ?")
      .run("github-installation", event.id);
    await reconcileGitHubAcceptanceChecks(env, 10);
    expect(f.sqlite.prepare("SELECT conclusion, check_run_id FROM acceptance_github_check_runs WHERE config_id = ? AND event_id = ?")
      .get("github-installation", event.id)).toMatchObject({ conclusion: "failure", check_run_id: "2" });
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ conclusion: "failure" });
  });

  it("refreshes GitHub checks for one review through missing, fresh, and expired Cloudflare verification", async () => {
    const f = await sqliteFixture();
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    installGitHubRepository(f);
    const event = approvedEvent({ provider: "cloudflare" });
    let checkId = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/456/access_tokens") return Response.json({ token: "installation-token", expires_at: "2026-09-09T04:00:00Z" });
      if (url.pathname === "/repos/nib/example/check-runs" && init?.method === "POST") {
        checkId += 1;
        return Response.json({ id: checkId, html_url: `https://github.test/check/${checkId}` });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      ...f.env,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: await exportPKCS8(privateKey),
      GITHUB_API_URL: "https://github.test",
      ACCEPTANCE: currentReviewCoordinator(event),
    };

    await deliverAcceptanceEvent(event, env);
    expect(f.sqlite.prepare("SELECT conclusion FROM acceptance_github_check_runs WHERE config_id = ? AND event_id = ?")
      .get("github-installation", event.id)?.conclusion).toBe("action_required");

    f.sqlite.prepare(
      `INSERT INTO acceptance_provider_verifications(project_id, review_id, actor_id, idempotency_key, manifest_hash, commit_sha, verified_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch() + 60)`,
    ).run(projectId, event.reviewId, "github:123:workflow", "verify-fresh", event.manifestHash, event.manifest.build.commit);
    await refreshGitHubChecksForReview(env, projectId, event.reviewId);
    expect(f.sqlite.prepare("SELECT conclusion, check_run_id FROM acceptance_github_check_runs WHERE config_id = ? AND event_id = ?")
      .get("github-installation", event.id)).toMatchObject({ conclusion: "success", check_run_id: "2" });

    f.sqlite.prepare("UPDATE acceptance_provider_verifications SET expires_at = 1 WHERE project_id = ? AND review_id = ?")
      .run(projectId, event.reviewId);
    await refreshGitHubChecksForReview(env, projectId, event.reviewId);
    expect(f.sqlite.prepare("SELECT conclusion, check_run_id FROM acceptance_github_check_runs WHERE config_id = ? AND event_id = ?")
      .get("github-installation", event.id)).toMatchObject({ conclusion: "action_required", check_run_id: "3" });
  });

  it("reconciles a previously action-required Cloudflare check back to success after fresh verification", async () => {
    const f = await sqliteFixture();
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    installGitHubRepository(f);
    const event = approvedEvent({ provider: "cloudflare" });
    f.sqlite.prepare(
      `INSERT INTO acceptance_integration_events(
         id, project_id, review_id, subject, gate, revision, sequence, state, manifest_hash, payload_json, occurred_at, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      event.id,
      event.projectId,
      event.reviewId,
      event.subject,
      event.gate,
      event.revision,
      event.sequence,
      event.state,
      event.manifestHash,
      JSON.stringify(event),
      event.occurredAt,
    );
    f.sqlite.prepare(
      `INSERT INTO acceptance_github_check_heads(config_id, gate, head_sha, latest_sequence, event_id, claim_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run("github-installation", event.gate, event.manifest.build.commit, event.sequence, event.id, "claim-1");
    f.sqlite.prepare(
      `INSERT INTO acceptance_github_check_runs(
         id, config_id, event_id, project_id, review_id, gate, repository_id, head_sha, check_run_id, check_url, conclusion, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run("check-run-row", "github-installation", event.id, projectId, event.reviewId, event.gate, "123", event.manifest.build.commit, "check-1", "https://github.test/check/1", "action_required");
    f.sqlite.prepare(
      `INSERT INTO acceptance_provider_verifications(project_id, review_id, actor_id, idempotency_key, manifest_hash, commit_sha, verified_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch() + 60)`,
    ).run(projectId, event.reviewId, "github:123:workflow", "verify-key", event.manifestHash, event.manifest.build.commit);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/456/access_tokens") return Response.json({ token: "installation-token", expires_at: "2026-09-09T04:00:00Z" });
      if (url.pathname === "/repos/nib/example/check-runs" && init?.method === "POST") return Response.json({ id: 2, html_url: "https://github.test/check/2" });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await reconcileGitHubAcceptanceChecks({
      ...f.env,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: await exportPKCS8(privateKey),
      GITHUB_API_URL: "https://github.test",
      ACCEPTANCE: currentReviewCoordinator(event),
    }, 10);

    const checkPosts = fetchMock.mock.calls.filter((call) => String(call[0]) === "https://github.test/repos/nib/example/check-runs");
    expect(checkPosts).toHaveLength(1);
    expect(JSON.parse(String(checkPosts[0]?.[1]?.body))).toMatchObject({ conclusion: "success" });
    expect(f.sqlite.prepare("SELECT conclusion, check_run_id FROM acceptance_github_check_runs WHERE config_id = ? AND event_id = ?")
      .get("github-installation", event.id)).toMatchObject({ conclusion: "success", check_run_id: "2" });
  });

  it("throws a typed 403 when GitHub workflow provenance mismatches the manifest", () => {
    try {
      assertGithubPublication({
        provider: "github",
        id: "github:123:workflow",
        projectId,
        scopes: ["publish"],
        repositoryId: "other",
        repository: "nib/example",
        repositoryOwner: "nib",
        repositoryName: "example",
        workflowRef: "nib/example/.github/workflows/acceptance.yml@refs/heads/main",
        sha: "abc123",
        ref: "refs/heads/main",
      }, approvedEvent().manifest);
      throw new Error("expected provenance mismatch");
    } catch (error) {
      expect(parseAcceptanceError(error)).toMatchObject({ status: 403, code: "GITHUB_PROVENANCE_MISMATCH" });
    }
  });
});

function approvedEvent(overrides: { provider?: "cloudflare" | "external" } = {}): AcceptanceChangedEvent {
  return {
    id: "event-1",
    type: "acceptance.changed",
    projectId,
    reviewId: "review-1",
    subject: "github:nib/example:pull/12",
    gate: "visual",
    revision: 2,
    sequence: 9,
    state: "approved",
    manifestHash: "hash-current",
    occurredAt: "2026-09-09T00:00:00.000Z",
    receipt: "receipt",
    manifest: {
      contract: "nib.acceptance/v1",
      projectId,
      subject: "github:nib/example:pull/12",
      gate: "visual",
      title: "Visual acceptance",
      request: "Check visual behavior",
      change: "Updated UI",
      criteria: [{ id: "looks-right", text: "Looks right" }],
      build: {
        repository: { id: "123", owner: "nib", name: "example" },
        commit: "abc123",
        provider: overrides.provider ?? "external",
        previewUrl: "https://preview.test",
        deployment: { id: "deploy-1", components: [{ name: "web", versionId: "v1" }] },
        assumptions: [],
      },
      evidence: [],
    },
  };
}

function pullRequestPayload(sha: string): string {
  return JSON.stringify({
    action: "synchronize",
    repository: { id: 123, name: "example", owner: { login: "nib" } },
    pull_request: { number: 12, head: { sha } },
  });
}

function githubWebhookRequest(deliveryId: string, payload: string, signature: string, eventName = "pull_request"): Request {
  return new Request("https://nib.test/api/acceptance/v1/github/webhook", {
    method: "POST",
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": eventName,
      "x-hub-signature-256": signature,
    },
    body: payload,
  });
}

function currentReviewCoordinator(event: AcceptanceChangedEvent, invalidate = vi.fn(async () => undefined)): NonNullable<AcceptanceIntegrationEnv["ACCEPTANCE"]> {
  return {
    idFromName: () => "project-id",
    get: () => ({
      getCurrent: async () => ({
        id: event.reviewId,
        reviewId: event.reviewId,
        revision: event.revision,
        manifestHash: event.manifestHash,
        state: event.state,
        manifest: event.manifest,
      }),
      invalidate,
    }),
  } as unknown as NonNullable<AcceptanceIntegrationEnv["ACCEPTANCE"]>;
}

function staleCoordinator(): NonNullable<AcceptanceIntegrationEnv["ACCEPTANCE"]> {
  return {
    idFromName: () => "project-id",
    get: () => ({
      getCurrent: async () => ({
        id: "newer-review",
        reviewId: "newer-review",
        revision: 3,
        manifestHash: "newer-hash",
        state: "approved",
      }),
    }),
  } as unknown as NonNullable<AcceptanceIntegrationEnv["ACCEPTANCE"]>;
}

async function sqliteFixture(): Promise<{
  sqlite: AcceptanceTeamTestFixture["sqlite"];
  env: AcceptanceIntegrationEnv;
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const fixture = await createAcceptanceTeamTestFixture({
    accounts: [owner],
    migrations: ["0016_acceptance_integrations.sql", "0019_acceptance_provider_verifications.sql"],
  });
  sqliteFixtures.push(fixture);
  fixture.sqlite.prepare("INSERT INTO acceptance_teams(id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
    .run("team-1", "Team", owner.id);
  fixture.sqlite.prepare("INSERT INTO acceptance_team_members(team_id, account_id, role, added_by, added_at) VALUES (?, ?, 'owner', ?, 1)")
    .run("team-1", owner.id, owner.id);
  fixture.sqlite.prepare("INSERT INTO acceptance_projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
    .run(projectId, "team-1", "Project", owner.id);
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://cloudflare-dns.com") {
      return Response.json({ Answer: [{ data: "93.184.216.34" }] });
    }
    if (init?.method === "HEAD") return new Response(null, { status: 204 });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    sqlite: fixture.sqlite,
    env: {
      DB: fixture.db as unknown as D1Database,
      PUBLIC_ORIGIN: "https://nib.test",
      ACCEPTANCE_ENABLED: "true",
    },
    fetch: fetchMock,
  };
}

async function githubOidcFixture(overrides: {
  repositoryId?: string;
  repository?: string;
  workflowRef?: string;
  sha?: string;
  ref?: string;
  eventName?: string;
} = {}): Promise<{ token: string; jwks: { keys: unknown[] } }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  const token = await new SignJWT({
    repository_id: overrides.repositoryId ?? "123",
    repository: overrides.repository ?? "nib/example",
    workflow_ref: overrides.workflowRef ?? "nib/example/.github/workflows/acceptance.yml@refs/heads/main",
    sha: overrides.sha ?? "a".repeat(40),
    ref: overrides.ref ?? "refs/heads/main",
    actor: "octocat",
    event_name: overrides.eventName ?? "pull_request",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience("nib.acceptance/v1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { token, jwks: { keys: [jwk] } };
}

async function gitHubAppPrivateKey(): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return exportPKCS8(privateKey);
}

function githubLinkRequest(input: { ownershipOidcToken?: string }): Request {
  const body: Record<string, unknown> = {
    installationId: "456",
    repositoryId: "123",
    owner: "nib",
    name: "example",
    allowedWorkflows: ["nib/example/.github/workflows/acceptance.yml@refs/heads/main"],
    gates: ["acceptance"],
  };
  if (input.ownershipOidcToken !== undefined) body.ownershipOidcToken = input.ownershipOidcToken;
  return new Request(`https://nib.test/api/acceptance/v1/projects/${projectId}/integrations/github`, {
    method: "PUT",
    headers: { "content-type": "application/json", "idempotency-key": `github-link-${crypto.randomUUID()}` },
    body: JSON.stringify(body),
  });
}

function githubLinkFetch(jwks: { keys: unknown[] }): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "token.actions.githubusercontent.com") return Response.json(jwks);
    if (url.pathname === "/app/installations/456/access_tokens") return Response.json({ token: "installation-token", expires_at: "2026-09-09T04:00:00Z" });
    if (url.pathname === "/repositories/123") return Response.json({ id: 123, name: "example", default_branch: "main", owner: { login: "nib" } });
    return new Response(null, { status: 404 });
  });
}

function installGitHubRepository(f: { sqlite: AcceptanceTeamTestFixture["sqlite"] }, options: {
  id?: string;
  installationId?: string;
  repositoryId?: string;
  owner?: string;
  name?: string;
  workflowRef?: string;
} = {}): void {
  const repositoryOwner = options.owner ?? "nib";
  const repositoryName = options.name ?? "example";
  const workflowRef = options.workflowRef ?? `${repositoryOwner}/${repositoryName}/.github/workflows/acceptance.yml@refs/heads/main`;
  f.sqlite.prepare(
    `INSERT INTO acceptance_github_installations(
       id, project_id, installation_id, repository_id, repository_owner, repository_name,
       allowed_workflows_json, gates_json, enabled, created_by_account_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, 1, 1)`,
  ).run(
    options.id ?? "github-installation",
    projectId,
    options.installationId ?? "456",
    options.repositoryId ?? "123",
    repositoryOwner,
    repositoryName,
    JSON.stringify([workflowRef]),
    owner.id,
  );
}

async function insertGitHubWorkflowToken(f: { sqlite: AcceptanceTeamTestFixture["sqlite"] }, options: {
  token: string;
  actorId?: string;
  projectId?: string;
  scopes?: string[];
  repositoryId?: string;
  repository?: string;
  workflowRef?: string;
  sha?: string;
  ref?: string;
  eventName?: string;
}): Promise<void> {
  const repository = options.repository ?? "nib/example";
  const workflowRef = options.workflowRef ?? "nib/example/.github/workflows/acceptance.yml@refs/heads/main";
  f.sqlite.prepare(
    `INSERT INTO acceptance_github_workflow_tokens(
       token_hash, actor_id, project_id, scopes_json, repository_id, repository, workflow_ref,
       job_workflow_ref, sha, ref, event_name, github_actor, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, unixepoch() + 600, unixepoch())`,
  ).run(
    await sha256Hex(options.token),
    options.actorId ?? `github:${options.repositoryId ?? "123"}:${workflowRef}`,
    options.projectId ?? projectId,
    JSON.stringify(options.scopes ?? ["publish"]),
    options.repositoryId ?? "123",
    repository,
    workflowRef,
    options.sha ?? "a".repeat(40),
    options.ref ?? "refs/heads/main",
    options.eventName ?? "push",
    "octocat",
  );
}

class FakeD1 {
  statements: string[] = [];
  binds: unknown[][] = [];
  batchCalls = 0;
  integrationEventChanges = [1];
  githubDeliveryInsertChanges = [1];
  githubDeliveries = new Map<string, { event_name: string; payload_json: string; state: string; received_at: number; processing_started_at: number | null }>();
  webhookEndpoints: Record<string, unknown>[] = [];
  queuedDeliveries: Record<string, unknown>[] = [];
  sinkStates = new Map<string, string>();
  failWebhookEndpointQueryOnce = false;

  prepare(sql: string): FakeStatement {
    this.statements.push(sql);
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    this.batchCalls += 1;
    return statements.map((statement) => ({ sql: statement.sql }));
  }
}

class FakeStatement {
  values: unknown[] = [];

  constructor(private db: FakeD1, readonly sql: string) {}

  bind(...values: unknown[]): FakeStatement {
    this.values = values;
    this.db.binds.push(values);
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("acceptance_integration_event_sinks") && this.sql.includes("INSERT OR IGNORE")) {
      const key = `${this.values[0]}:${this.values[1]}`;
      if (this.db.sinkStates.has(key)) return { meta: { changes: 0 } };
      this.db.sinkStates.set(key, "pending");
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("acceptance_integration_event_sinks") && this.sql.includes("SET state = 'running'")) {
      const key = `${this.values[0]}:${this.values[1]}`;
      const state = this.db.sinkStates.get(key);
      if (state !== "pending" && state !== "failed") return { meta: { changes: 0 } };
      this.db.sinkStates.set(key, "running");
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("acceptance_integration_event_sinks") && this.sql.includes("SET state = 'done'")) {
      this.db.sinkStates.set(`${this.values[0]}:${this.values[1]}`, "done");
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("acceptance_integration_event_sinks") && this.sql.includes("SET state = 'failed'")) {
      this.db.sinkStates.set(`${this.values[1]}:${this.values[2]}`, "failed");
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("acceptance_integration_events")) {
      return { meta: { changes: this.db.integrationEventChanges.shift() ?? 0 } };
    }
    if (this.sql.includes("acceptance_github_webhook_deliveries") && this.sql.includes("INSERT OR IGNORE")) {
      const id = String(this.values[0]);
      if (this.db.githubDeliveries.has(id)) return { meta: { changes: 0 } };
      const changes = this.db.githubDeliveryInsertChanges.shift() ?? 1;
      if (changes) {
        this.db.githubDeliveries.set(id, {
          event_name: String(this.values[1]),
          payload_json: String(this.values[2]),
          state: "received",
          received_at: 1,
          processing_started_at: null,
        });
      }
      return { meta: { changes } };
    }
    if (this.sql.includes("acceptance_github_webhook_deliveries") && this.sql.includes("SET state = 'processing'")) {
      const id = String(this.values[0]);
      const row = this.db.githubDeliveries.get(id);
      if (!row) return { meta: { changes: 0 } };
      if (row.state === "received" || row.state === "failed" || (row.state === "processing" && (row.processing_started_at ?? row.received_at) <= 0)) {
        row.state = "processing";
        row.processing_started_at = 1;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.sql.includes("acceptance_github_webhook_deliveries") && this.sql.includes("processed_at = unixepoch()")) {
      const row = this.db.githubDeliveries.get(String(this.values[1]));
      if (row) {
        row.state = String(this.values[0]);
        row.processing_started_at = null;
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.includes("acceptance_webhook_deliveries") && this.sql.includes("INSERT OR IGNORE")) {
      this.db.queuedDeliveries.push({
        id: "delivery-1",
        webhook_id: "webhook-1",
        project_id: projectId,
        event_id: "event-1",
        project_sequence: 1,
        payload_json: this.values[5],
      });
    }
    return { meta: { changes: 1 } };
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("acceptance_integration_event_sinks") && this.sql.includes("SELECT state")) {
      const state = this.db.sinkStates.get(`${this.values[0]}:${this.values[1]}`);
      return state ? { state } as T : null;
    }
    if (this.sql.includes("acceptance_github_webhook_deliveries") && this.sql.includes("SELECT event_name")) {
      return this.db.githubDeliveries.get(String(this.values[0])) as T ?? null;
    }
    if (this.sql.includes("acceptance_github_pull_heads")) return null;
    if (this.sql.includes("acceptance_webhook_project_sequences")) return { next_sequence: 1 } as T;
    if (this.sql.includes("acceptance_webhook_attempts")) return { count: 0 } as T;
    if (this.sql.includes("acceptance_webhook_endpoints")) return this.db.webhookEndpoints[0] as T ?? null;
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("acceptance_webhook_endpoints") && this.db.failWebhookEndpointQueryOnce) {
      this.db.failWebhookEndpointQueryOnce = false;
      throw new Error("endpoint query failed");
    }
    if (this.sql.includes("acceptance_webhook_endpoints")) return { results: this.db.webhookEndpoints as T[] };
    if (this.sql.includes("acceptance_webhook_deliveries")) return { results: this.db.queuedDeliveries as T[] };
    if (this.sql.includes("acceptance_github_installations")) return { results: [] };
    return { results: [] };
  }
}
