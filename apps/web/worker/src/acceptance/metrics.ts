import { sha256Hex } from "./common";

export const ACCEPTANCE_METRIC_EVENT_TYPES = [
  "review_published",
  "review_page_viewed",
  "preview_opened",
  "review_decision_recorded",
] as const;

export type AcceptanceMetricEventType = typeof ACCEPTANCE_METRIC_EVENT_TYPES[number];
export type AcceptanceMetricDecision = "approve" | "reject" | "request_revision";

export interface AcceptanceMetricEnv {
  DB: D1Database;
}

export interface RecordAcceptanceMetricInput {
  eventType: AcceptanceMetricEventType;
  projectId: string;
  reviewId: string;
  actorId: string;
  idempotencyKey: string;
  revision?: number;
  decision?: AcceptanceMetricDecision;
  occurredAt?: number;
}

export interface RecordAcceptanceMetricResult {
  id: string;
  inserted: boolean;
  occurredAt: number;
}

export interface AcceptanceProjectMetrics {
  projectId: string;
  projectCreatedAt: number | null;
  events: {
    total: number;
    reviewPublished: number;
    reviewPageViewed: number;
    previewOpened: number;
    reviewDecisionRecorded: number;
  };
  distinct: {
    publishedReviews: number;
    humanViewedReviews: number;
    previewOpenedReviews: number;
    decidedReviews: number;
    activeReviews: number;
    pageViewers: number;
    previewOpeners: number;
    decisionReviewers: number;
    activeReviewers: number;
  };
  revisions: {
    published: number;
    decided: number;
  };
  firstReview: {
    publishedAt: number | null;
    humanPageViewedAt: number | null;
    previewOpenedAt: number | null;
    decisionRecordedAt: number | null;
    humanPageViewAfterPublishSeconds: number | null;
    previewOpenAfterPublishSeconds: number | null;
    decisionAfterPublishSeconds: number | null;
  };
  github: {
    installations: number;
    firstInstallationAt: number | null;
    installToFirstReviewSeconds: number | null;
  };
  repeatUsage: {
    reviewersWithMultipleReviews: number;
    reviewsWithMultipleHumanEventTypes: number;
  };
}

export class AcceptanceMetricError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AcceptanceMetricError";
  }
}

interface StoredMetricRow {
  review_id: string;
  actor_id: string;
  revision: number | null;
  decision: AcceptanceMetricDecision | null;
  occurred_at: number;
}

interface UsageAggregateRow {
  total: number;
  review_published: number;
  review_page_viewed: number;
  preview_opened: number;
  review_decision_recorded: number;
  published_reviews: number;
  human_viewed_reviews: number;
  preview_opened_reviews: number;
  decided_reviews: number;
  active_reviews: number;
  page_viewers: number;
  preview_openers: number;
  decision_reviewers: number;
  active_reviewers: number;
  published_revisions: number;
  decided_revisions: number;
  first_review_published_at: number | null;
  first_human_page_viewed_at: number | null;
  first_preview_opened_at: number | null;
  first_decision_recorded_at: number | null;
}

interface ProjectRow {
  created_at: number;
}

interface GitHubAggregateRow {
  installations: number;
  first_installation_at: number | null;
}

interface CountRow {
  count: number;
}

interface NormalizedMetricInput {
  eventType: AcceptanceMetricEventType;
  projectId: string;
  reviewId: string;
  actorId: string;
  idempotencyKey: string;
  revision?: number;
  decision?: AcceptanceMetricDecision;
  occurredAt: number;
}

const metricEventTypes = new Set<string>(ACCEPTANCE_METRIC_EVENT_TYPES);
const metricDecisions = new Set<string>(["approve", "reject", "request_revision"]);
const humanEventSql = "('review_page_viewed', 'preview_opened', 'review_decision_recorded')";

export async function recordAcceptanceMetric(
  env: AcceptanceMetricEnv,
  input: RecordAcceptanceMetricInput,
): Promise<RecordAcceptanceMetricResult> {
  const normalized = normalizeMetricInput(input);
  const id = await sha256Hex([
    normalized.projectId,
    normalized.eventType,
    normalized.actorId,
    normalized.idempotencyKey,
  ].join("\0"));

  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO acceptance_usage_events(
       id, project_id, review_id, actor_id, event_type, idempotency_key, revision, decision, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    normalized.projectId,
    normalized.reviewId,
    normalized.actorId,
    normalized.eventType,
    normalized.idempotencyKey,
    normalized.revision ?? null,
    normalized.decision ?? null,
    normalized.occurredAt,
  ).run();

  const stored = await env.DB.prepare(
    `SELECT review_id, actor_id, revision, decision, occurred_at
       FROM acceptance_usage_events
      WHERE id = ?`,
  ).bind(id).first<StoredMetricRow>();
  if (!stored) throw new AcceptanceMetricError(500, "metric_insert_failed", "Acceptance metric insert could not be read back.");
  if (
    stored.review_id !== normalized.reviewId ||
    stored.actor_id !== normalized.actorId ||
    nullableNumber(stored.revision) !== normalized.revision ||
    nullableString(stored.decision) !== normalized.decision
  ) {
    throw new AcceptanceMetricError(409, "idempotency_conflict", "Acceptance metric idempotency key was reused for a different event.");
  }

  return {
    id,
    inserted: Number(insert.meta.changes) > 0,
    occurredAt: numberValue(stored.occurred_at),
  };
}

export async function readProjectMetrics(db: D1Database, projectId: string): Promise<AcceptanceProjectMetrics> {
  const project = await db.prepare(
    "SELECT created_at FROM acceptance_projects WHERE id = ?",
  ).bind(projectId).first<ProjectRow>();
  const usage = await db.prepare(
    `SELECT
       COUNT(*) AS total,
       COUNT(CASE WHEN event_type = 'review_published' THEN 1 END) AS review_published,
       COUNT(CASE WHEN event_type = 'review_page_viewed' THEN 1 END) AS review_page_viewed,
       COUNT(CASE WHEN event_type = 'preview_opened' THEN 1 END) AS preview_opened,
       COUNT(CASE WHEN event_type = 'review_decision_recorded' THEN 1 END) AS review_decision_recorded,
       COUNT(DISTINCT CASE WHEN event_type = 'review_published' THEN review_id END) AS published_reviews,
       COUNT(DISTINCT CASE WHEN event_type = 'review_page_viewed' THEN review_id END) AS human_viewed_reviews,
       COUNT(DISTINCT CASE WHEN event_type = 'preview_opened' THEN review_id END) AS preview_opened_reviews,
       COUNT(DISTINCT CASE WHEN event_type = 'review_decision_recorded' THEN review_id END) AS decided_reviews,
       COUNT(DISTINCT CASE WHEN event_type IN ${humanEventSql} THEN review_id END) AS active_reviews,
       COUNT(DISTINCT CASE WHEN event_type = 'review_page_viewed' THEN actor_id END) AS page_viewers,
       COUNT(DISTINCT CASE WHEN event_type = 'preview_opened' THEN actor_id END) AS preview_openers,
       COUNT(DISTINCT CASE WHEN event_type = 'review_decision_recorded' THEN actor_id END) AS decision_reviewers,
       COUNT(DISTINCT CASE WHEN event_type IN ${humanEventSql} THEN actor_id END) AS active_reviewers,
       COUNT(DISTINCT CASE WHEN event_type = 'review_published' THEN review_id || ':' || COALESCE(CAST(revision AS TEXT), '') END) AS published_revisions,
       COUNT(DISTINCT CASE WHEN event_type = 'review_decision_recorded' THEN review_id || ':' || COALESCE(CAST(revision AS TEXT), '') END) AS decided_revisions,
       MIN(CASE WHEN event_type = 'review_published' THEN occurred_at END) AS first_review_published_at,
       MIN(CASE WHEN event_type = 'review_page_viewed' THEN occurred_at END) AS first_human_page_viewed_at,
       MIN(CASE WHEN event_type = 'preview_opened' THEN occurred_at END) AS first_preview_opened_at,
       MIN(CASE WHEN event_type = 'review_decision_recorded' THEN occurred_at END) AS first_decision_recorded_at
     FROM acceptance_usage_events
     WHERE project_id = ?`,
  ).bind(projectId).first<UsageAggregateRow>();
  const github = await db.prepare(
    `SELECT COUNT(*) AS installations, MIN(created_at) AS first_installation_at
       FROM acceptance_github_installations
      WHERE project_id = ?`,
  ).bind(projectId).first<GitHubAggregateRow>();
  const repeatReviewers = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM (
         SELECT actor_id
           FROM acceptance_usage_events
          WHERE project_id = ? AND event_type IN ${humanEventSql}
          GROUP BY actor_id
         HAVING COUNT(DISTINCT review_id) >= 2
       )`,
  ).bind(projectId).first<CountRow>();
  const repeatReviews = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM (
         SELECT review_id
           FROM acceptance_usage_events
          WHERE project_id = ? AND event_type IN ${humanEventSql}
          GROUP BY review_id
         HAVING COUNT(DISTINCT event_type) >= 2
       )`,
  ).bind(projectId).first<CountRow>();

  const firstPublishedAt = optionalNumber(usage?.first_review_published_at);
  const firstInstallationAt = optionalNumber(github?.first_installation_at);

  return {
    projectId,
    projectCreatedAt: optionalNumber(project?.created_at),
    events: {
      total: numberValue(usage?.total),
      reviewPublished: numberValue(usage?.review_published),
      reviewPageViewed: numberValue(usage?.review_page_viewed),
      previewOpened: numberValue(usage?.preview_opened),
      reviewDecisionRecorded: numberValue(usage?.review_decision_recorded),
    },
    distinct: {
      publishedReviews: numberValue(usage?.published_reviews),
      humanViewedReviews: numberValue(usage?.human_viewed_reviews),
      previewOpenedReviews: numberValue(usage?.preview_opened_reviews),
      decidedReviews: numberValue(usage?.decided_reviews),
      activeReviews: numberValue(usage?.active_reviews),
      pageViewers: numberValue(usage?.page_viewers),
      previewOpeners: numberValue(usage?.preview_openers),
      decisionReviewers: numberValue(usage?.decision_reviewers),
      activeReviewers: numberValue(usage?.active_reviewers),
    },
    revisions: {
      published: numberValue(usage?.published_revisions),
      decided: numberValue(usage?.decided_revisions),
    },
    firstReview: {
      publishedAt: firstPublishedAt,
      humanPageViewedAt: optionalNumber(usage?.first_human_page_viewed_at),
      previewOpenedAt: optionalNumber(usage?.first_preview_opened_at),
      decisionRecordedAt: optionalNumber(usage?.first_decision_recorded_at),
      humanPageViewAfterPublishSeconds: deltaSeconds(firstPublishedAt, optionalNumber(usage?.first_human_page_viewed_at)),
      previewOpenAfterPublishSeconds: deltaSeconds(firstPublishedAt, optionalNumber(usage?.first_preview_opened_at)),
      decisionAfterPublishSeconds: deltaSeconds(firstPublishedAt, optionalNumber(usage?.first_decision_recorded_at)),
    },
    github: {
      installations: numberValue(github?.installations),
      firstInstallationAt,
      installToFirstReviewSeconds: deltaSeconds(firstInstallationAt, firstPublishedAt),
    },
    repeatUsage: {
      reviewersWithMultipleReviews: numberValue(repeatReviewers?.count),
      reviewsWithMultipleHumanEventTypes: numberValue(repeatReviews?.count),
    },
  };
}

function normalizeMetricInput(input: RecordAcceptanceMetricInput): NormalizedMetricInput {
  if (!metricEventTypes.has(input.eventType)) {
    throw new AcceptanceMetricError(400, "metric_event_type_invalid", "Acceptance metric event type is not supported.");
  }
  const projectId = requiredString(input.projectId, "project_id_required", "Project id is required.");
  const reviewId = requiredString(input.reviewId, "review_id_required", "Review id is required.");
  const actorId = requiredString(input.actorId, "actor_id_required", "Authenticated actor id is required.");
  if (actorId === "public") {
    throw new AcceptanceMetricError(401, "authenticated_actor_required", "Acceptance metrics require an authenticated actor.");
  }
  const idempotencyKey = requiredString(input.idempotencyKey, "idempotency_key_required", "Metric idempotency key is required.");
  if (idempotencyKey.length > 200) {
    throw new AcceptanceMetricError(400, "idempotency_key_invalid", "Metric idempotency key is too long.");
  }
  const revision = normalizeRevision(input);
  const decision = normalizeDecision(input);
  const occurredAt = input.occurredAt === undefined ? Math.floor(Date.now() / 1000) : normalizeTimestamp(input.occurredAt);
  return { eventType: input.eventType, projectId, reviewId, actorId, idempotencyKey, revision, decision, occurredAt };
}

function requiredString(value: string | undefined, code: string, message: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new AcceptanceMetricError(400, code, message);
  return trimmed;
}

function normalizeRevision(input: RecordAcceptanceMetricInput): number | undefined {
  if (input.eventType !== "review_published" && input.eventType !== "review_decision_recorded") return undefined;
  const revision = input.revision;
  if (!Number.isSafeInteger(revision) || revision === undefined || revision < 1) {
    throw new AcceptanceMetricError(400, "revision_required", "Publish and decision metrics require a positive integer revision.");
  }
  return revision;
}

function normalizeDecision(input: RecordAcceptanceMetricInput): AcceptanceMetricDecision | undefined {
  if (input.eventType !== "review_decision_recorded") return undefined;
  if (!input.decision || !metricDecisions.has(input.decision)) {
    throw new AcceptanceMetricError(400, "decision_required", "Decision metrics require a supported decision.");
  }
  return input.decision;
}

function normalizeTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AcceptanceMetricError(400, "occurred_at_invalid", "Metric timestamp must be a non-negative integer.");
  }
  return value;
}

function numberValue(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : numberValue(value);
}

function nullableString(value: unknown): AcceptanceMetricDecision | undefined {
  return value === null || value === undefined ? undefined : value as AcceptanceMetricDecision;
}

function deltaSeconds(start: number | null, end: number | null): number | null {
  if (start === null || end === null || end < start) return null;
  return end - start;
}
