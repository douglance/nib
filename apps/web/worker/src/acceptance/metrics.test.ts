import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAcceptanceTeamTestFixture, type AcceptanceTeamTestFixture } from "./team-test-db";
import { AcceptanceMetricError, readProjectMetrics, recordAcceptanceMetric } from "./metrics";

const projectId = "11111111-1111-4111-8111-111111111111";
const reviewId = "22222222-2222-4222-8222-222222222222";
const secondReviewId = "33333333-3333-4333-8333-333333333333";

let fixture: AcceptanceTeamTestFixture;
let env: { DB: D1Database };

beforeEach(async () => {
  fixture = await createAcceptanceTeamTestFixture({
    accounts: [
      { id: "owner", email: "owner@example.test" },
      { id: "reviewer", email: "reviewer@example.test" },
    ],
    migrations: [
      "0016_acceptance_integrations.sql",
      "0017_acceptance_delivery_and_evidence.sql",
      "0018_acceptance_usage.sql",
    ],
  });
  fixture.sqlite.exec(`
    INSERT INTO acceptance_teams(id, name, created_by, created_at, updated_at)
    VALUES ('team', 'Team', 'owner', 50, 50);
    INSERT INTO acceptance_team_members(team_id, account_id, role, added_by, added_at)
    VALUES ('team', 'owner', 'owner', 'owner', 50);
    INSERT INTO acceptance_projects(id, team_id, name, created_by, created_at, updated_at)
    VALUES ('${projectId}', 'team', 'Project', 'owner', 60, 60);
    INSERT INTO acceptance_github_installations(
      id, project_id, installation_id, repository_id, repository_owner, repository_name,
      allowed_workflows_json, enabled, created_by_account_id, created_at, updated_at
    )
    VALUES ('github-install', '${projectId}', '1001', '2002', 'nib', 'example', '["*"]', 1, 'owner', 100, 100);
  `);
  env = { DB: fixture.db as unknown as D1Database };
});

afterEach(() => fixture.sqlite.close());

describe("acceptance usage metrics", () => {
  it("records explicit acceptance signals idempotently and reads bounded activation aggregates", async () => {
    const firstPublish = await recordAcceptanceMetric(env, {
      eventType: "review_published",
      projectId,
      reviewId,
      actorId: "github:nib/example",
      idempotencyKey: "publish:1",
      revision: 1,
      occurredAt: 150,
    });
    const replay = await recordAcceptanceMetric(env, {
      eventType: "review_published",
      projectId,
      reviewId,
      actorId: "github:nib/example",
      idempotencyKey: "publish:1",
      revision: 1,
      occurredAt: 999,
    });
    await recordAcceptanceMetric(env, {
      eventType: "review_page_viewed",
      projectId,
      reviewId,
      actorId: "reviewer",
      idempotencyKey: "view:1",
      occurredAt: 160,
    });
    await recordAcceptanceMetric(env, {
      eventType: "review_page_viewed",
      projectId,
      reviewId,
      actorId: "reviewer",
      idempotencyKey: "view:refresh",
      occurredAt: 170,
    });
    await recordAcceptanceMetric(env, {
      eventType: "preview_opened",
      projectId,
      reviewId,
      actorId: "reviewer",
      idempotencyKey: "preview:1",
      occurredAt: 180,
    });
    await recordAcceptanceMetric(env, {
      eventType: "review_decision_recorded",
      projectId,
      reviewId,
      actorId: "reviewer",
      idempotencyKey: "decision:1",
      revision: 1,
      decision: "approve",
      occurredAt: 190,
    });
    await recordAcceptanceMetric(env, {
      eventType: "review_published",
      projectId,
      reviewId,
      actorId: "github:nib/example",
      idempotencyKey: "publish:2",
      revision: 2,
      occurredAt: 200,
    });
    await recordAcceptanceMetric(env, {
      eventType: "review_decision_recorded",
      projectId,
      reviewId,
      actorId: "reviewer",
      idempotencyKey: "decision:2",
      revision: 2,
      decision: "request_revision",
      occurredAt: 210,
    });
    await recordAcceptanceMetric(env, {
      eventType: "review_page_viewed",
      projectId,
      reviewId: secondReviewId,
      actorId: "reviewer",
      idempotencyKey: "view:second",
      occurredAt: 220,
    });
    await recordAcceptanceMetric(env, {
      eventType: "preview_opened",
      projectId,
      reviewId: secondReviewId,
      actorId: "owner",
      idempotencyKey: "preview:second",
      occurredAt: 230,
    });

    const metrics = await readProjectMetrics(fixture.db as unknown as D1Database, projectId);

    expect(firstPublish.inserted).toBe(true);
    expect(replay).toMatchObject({ id: firstPublish.id, inserted: false, occurredAt: 150 });
    expect(metrics).toMatchObject({
      projectCreatedAt: 60,
      events: {
        total: 9,
        reviewPublished: 2,
        reviewPageViewed: 3,
        previewOpened: 2,
        reviewDecisionRecorded: 2,
      },
      distinct: {
        publishedReviews: 1,
        humanViewedReviews: 2,
        previewOpenedReviews: 2,
        decidedReviews: 1,
        activeReviews: 2,
        pageViewers: 1,
        previewOpeners: 2,
        decisionReviewers: 1,
        activeReviewers: 2,
      },
      revisions: { published: 2, decided: 2 },
      firstReview: {
        publishedAt: 150,
        humanPageViewedAt: 160,
        previewOpenedAt: 180,
        decisionRecordedAt: 190,
        humanPageViewAfterPublishSeconds: 10,
        previewOpenAfterPublishSeconds: 30,
        decisionAfterPublishSeconds: 40,
      },
      github: {
        installations: 1,
        firstInstallationAt: 100,
        installToFirstReviewSeconds: 50,
      },
      repeatUsage: {
        reviewersWithMultipleReviews: 1,
        reviewsWithMultipleHumanEventTypes: 2,
      },
    });
  });

  it("rejects unauthenticated actors and idempotency key reuse with different event data", async () => {
    await expect(recordAcceptanceMetric(env, {
      eventType: "review_page_viewed",
      projectId,
      reviewId,
      actorId: "public",
      idempotencyKey: "view:public",
      occurredAt: 150,
    })).rejects.toMatchObject({ status: 401, code: "authenticated_actor_required" });

    await recordAcceptanceMetric(env, {
      eventType: "review_published",
      projectId,
      reviewId,
      actorId: "github:nib/example",
      idempotencyKey: "publish:1",
      revision: 1,
      occurredAt: 150,
    });
    await expect(recordAcceptanceMetric(env, {
      eventType: "review_published",
      projectId,
      reviewId: secondReviewId,
      actorId: "github:nib/example",
      idempotencyKey: "publish:1",
      revision: 1,
      occurredAt: 151,
    })).rejects.toBeInstanceOf(AcceptanceMetricError);
    await expect(recordAcceptanceMetric(env, {
      eventType: "review_decision_recorded",
      projectId,
      reviewId,
      actorId: "reviewer",
      idempotencyKey: "decision:missing-revision",
      decision: "approve",
      occurredAt: 152,
    })).rejects.toMatchObject({ status: 400, code: "revision_required" });
  });
});
