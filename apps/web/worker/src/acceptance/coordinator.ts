import { DurableObject } from "cloudflare:workers";
import {
  AcceptanceError,
  canonicalJson,
  hashAcceptanceManifest,
  normalizeAcceptancePolicy,
  validateAcceptanceManifest,
  type AcceptanceComment,
  type AcceptanceDecision,
  type AcceptanceEvent,
  type AcceptanceManifest,
  type AcceptancePolicy,
  type AcceptanceReview,
  type AcceptanceState,
  type AcceptanceVerifyResult,
  type AcceptanceEventReason,
  type AcceptanceVote,
  type DecisionInput,
  type PublishContext,
  type VerifyExpected,
} from "./contracts";
import { signAcceptanceReceipt, type AcceptanceReceiptSigningEnv } from "./receipts";

const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_COMMENT_LENGTH = 4_096;

export interface AcceptanceCoordinatorEnv extends AcceptanceReceiptSigningEnv {
  ACCEPTANCE_EVENTS: Queue<AcceptanceEvent>;
}

export interface AcceptanceMutation {
  idempotency?: {
    key: string;
    fingerprint: string;
    result: unknown;
  };
  reviews?: AcceptanceReview[];
  current?: {
    subject: string;
    gate: string;
    reviewId: string;
  }[];
  events?: AcceptanceEvent[];
}

export interface AcceptanceStore {
  getReview(id: string): Promise<AcceptanceReview | undefined>;
  listReviews(): Promise<AcceptanceReview[]>;
  getCurrentId(subject: string, gate: string): Promise<string | undefined>;
  getIdempotency(key: string): Promise<{ fingerprint: string; result: unknown } | undefined>;
  nextSequence(): Promise<number>;
  commit(mutation: AcceptanceMutation): Promise<void>;
  listOutbox(limit: number): Promise<AcceptanceEvent[]>;
  deleteOutbox(id: string): Promise<void>;
  scheduleNextAlarm?(): Promise<void>;
}

export interface AcceptanceSqlResult<T> {
  toArray(): T[];
  one(): T;
}

export interface AcceptanceSqlExecutor {
  exec<T>(statement: string, ...bindings: unknown[]): AcceptanceSqlResult<T>;
}

export interface AcceptanceSqlStorage {
  sql: AcceptanceSqlExecutor;
  transactionSync<T>(callback: () => T): T;
  setAlarm?(scheduledTime: number): Promise<void>;
}

export interface AcceptanceClock {
  now(): Date;
}

export interface AcceptanceIdSource {
  randomId(): string;
}

export type AcceptanceReceiptSigner = (review: AcceptanceReview) => Promise<string>;

export interface AcceptanceCoreOptions {
  clock?: AcceptanceClock;
  ids?: AcceptanceIdSource;
  signReceipt?: AcceptanceReceiptSigner;
}

export interface AcceptanceEventContext {
  actorId?: string;
  reason?: AcceptanceEventReason;
  occurredAt?: string;
}

export class AcceptanceCore {
  private readonly clock: AcceptanceClock;
  private readonly ids: AcceptanceIdSource;
  private readonly signReceipt?: AcceptanceReceiptSigner;
  private operationTail: Promise<void>;

  constructor(
    private readonly store: AcceptanceStore,
    options: AcceptanceCoreOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? { randomId: () => crypto.randomUUID() };
    this.signReceipt = options.signReceipt;
    this.operationTail = Promise.resolve();
  }

  async publish(
    rawManifest: AcceptanceManifest,
    context: PublishContext,
    idempotencyKey: string,
  ): Promise<AcceptanceReview> {
    return this.serialized(async () => {
    const manifest = validateAcceptanceManifest(rawManifest);
    const manifestHash = await hashAcceptanceManifest(manifest);
    const policy = normalizeAcceptancePolicy(context.policy);
    const eligibleReviewers = distinctNonEmpty(context.eligibleReviewers, "eligible reviewers");
    if (eligibleReviewers.length < policy.quorum) {
      throw new AcceptanceError(400, "ACCEPTANCE_QUORUM_UNSATISFIABLE", "Acceptance quorum exceeds eligible reviewers");
    }
    const fingerprint = canonicalJson({
      op: "publish",
      actorId: context.actorId,
      eligibleReviewers,
      manifestHash,
      policy,
    });

    return this.idempotent(idempotencyKey, fingerprint, async () => {
      const now = this.isoNow();
      const reviews = await this.store.listReviews();
      const sameGate = reviews.filter((review) => review.subject === manifest.subject && review.gate === manifest.gate);
      const revision = sameGate.reduce((max, review) => Math.max(max, review.revision), 0) + 1;
      const currentId = await this.store.getCurrentId(manifest.subject, manifest.gate);
      const currentReview = currentId ? await this.store.getReview(currentId) : undefined;
      const changedReviews: AcceptanceReview[] = [];
      const events: AcceptanceEvent[] = [];
      const reviewId = this.ids.randomId();

      if (currentReview && currentReview.state !== "superseded" && currentReview.state !== "invalidated") {
        const reconciledCurrent = this.reconcileReview(currentReview);
        if (reconciledCurrent.state === "expired") {
          changedReviews.push(reconciledCurrent);
          events.push(await this.eventFor(reconciledCurrent, { actorId: context.actorId, reason: "expired" }));
        } else {
          const superseded = { ...reconciledCurrent, state: "superseded" as const, supersededBy: reviewId };
          changedReviews.push(superseded);
          events.push(await this.eventFor(superseded, { actorId: context.actorId, reason: "superseded_by_new_revision" }));
        }
      }

      const review: AcceptanceReview = {
        id: reviewId,
        projectId: manifest.projectId,
        subject: manifest.subject,
        gate: manifest.gate,
        revision,
        manifest,
        manifestHash,
        state: "pending",
        policy,
        eligibleReviewers,
        createdAt: now,
        expiresAt: addSeconds(this.clock.now(), policy.ttlSeconds).toISOString(),
        publishedBy: context.actorId,
        votes: [],
        comments: [],
        receipt: null,
      };
      changedReviews.push(review);
      events.push(await this.eventFor(review, { actorId: context.actorId, reason: "published" }));
      await this.store.commit({
        idempotency: { key: idempotencyKey, fingerprint, result: review },
        reviews: changedReviews,
        current: [{ subject: review.subject, gate: review.gate, reviewId: review.id }],
        events,
      });
      return review;
    });
    });
  }

  async getReview(id: string, eligibleReviewers?: string[]): Promise<AcceptanceReview | undefined> {
    return this.serialized(async () => {
    const review = await this.store.getReview(id);
    if (!review) return undefined;
    return this.reconcileForRead(review, eligibleReviewers);
    });
  }

  async listReviews(eligibleReviewers?: string[]): Promise<AcceptanceReview[]> {
    return this.serialized(async () => {
    const reviews = await this.store.listReviews();
    const reconciled = await Promise.all(reviews.map((review) => this.reconcileForRead(review, eligibleReviewers)));
    return reconciled.sort((left, right) => right.revision - left.revision || right.createdAt.localeCompare(left.createdAt));
    });
  }

  async getCurrent(subject: string, gate: string, eligibleReviewers?: string[]): Promise<AcceptanceReview | null> {
    return this.serialized(async () => {
    const currentId = await this.store.getCurrentId(subject, gate);
    if (!currentId) return null;
    const review = await this.store.getReview(currentId);
    return review ? this.reconcileForRead(review, eligibleReviewers) : null;
    });
  }

  async decide(
    id: string,
    input: DecisionInput,
    context: { actorId: string; eligibleReviewers: string[] },
    idempotencyKey: string,
  ): Promise<AcceptanceReview> {
    return this.serialized(async () => {
    const reviewerIds = distinctNonEmpty(context.eligibleReviewers, "eligible reviewers");
    const decisionInput = normalizeDecisionInput(input);
    if (!reviewerIds.includes(context.actorId)) {
      throw new AcceptanceError(403, "ACCEPTANCE_REVIEWER_NOT_ELIGIBLE", "Actor is not eligible to decide this review");
    }
    const fingerprint = canonicalJson({
      op: "decide",
      id,
      actorId: context.actorId,
      input: decisionInput,
      eligibleReviewers: reviewerIds,
    });

    return this.idempotent(idempotencyKey, fingerprint, async () => {
      let review = await this.prepareEditableReview(id, reviewerIds);
      this.assertPending(review);
      this.assertKnownCriteria(review, decisionInput.criteriaIds);
      if (review.votes.some((vote) => vote.actorId === context.actorId)) {
        throw new AcceptanceError(409, "ACCEPTANCE_DECISION_ALREADY_RECORDED", "Actor already decided this review");
      }
      if (decisionInput.decision === "approve") this.assertApprovesEveryCriterion(review, decisionInput.criteriaIds);

      const vote: AcceptanceVote = {
        actorId: context.actorId,
        decision: decisionInput.decision,
        ...(decisionInput.comment === undefined ? {} : { comment: decisionInput.comment }),
        criteriaIds: [...decisionInput.criteriaIds],
        createdAt: this.isoNow(),
      };
      review = { ...review, votes: [...review.votes, vote] };
      review = await this.settleAfterDecision(review);
      await this.commitReviewMutation(idempotencyKey, fingerprint, review, review, {
        actorId: context.actorId,
        reason: review.state === "approved" ? "approved" : decisionInput.decision,
      });
      return review;
    });
    });
  }

  async comment(id: string, text: string, actorId: string, idempotencyKey: string): Promise<AcceptanceReview> {
    return this.serialized(async () => {
    const normalizedText = text.trim();
    if (!normalizedText) throw new AcceptanceError(400, "INVALID_ACCEPTANCE_COMMENT", "Comment text is required");
    if (normalizedText.length > MAX_COMMENT_LENGTH) {
      throw new AcceptanceError(400, "INVALID_ACCEPTANCE_COMMENT", `Comment text cannot exceed ${MAX_COMMENT_LENGTH} characters`);
    }
    const fingerprint = canonicalJson({ op: "comment", id, actorId, text: normalizedText });
    return this.idempotent(idempotencyKey, fingerprint, async () => {
      const review = await this.prepareEditableReview(id);
      this.assertPending(review);
      const comment: AcceptanceComment = {
        id: this.ids.randomId(),
        actorId,
        text: normalizedText,
        createdAt: this.isoNow(),
      };
      const changed = { ...review, comments: [...review.comments, comment] };
      await this.commitReviewMutation(idempotencyKey, fingerprint, changed, changed, { actorId, reason: "commented" });
      return changed;
    });
    });
  }

  async openPreview(id: string, actorId: string, idempotencyKey: string): Promise<AcceptanceReview> {
    return this.serialized(async () => {
    const fingerprint = canonicalJson({ op: "openPreview", id, actorId });
    return this.idempotent(idempotencyKey, fingerprint, async () => {
      const review = await this.requiredReview(id);
      await this.store.commit({
        idempotency: { key: idempotencyKey, fingerprint, result: review },
        events: [await this.eventFor(review, { actorId, reason: "preview_opened" })],
      });
      return review;
    });
    });
  }

  async invalidate(id: string, reason: string, actorId: string, idempotencyKey: string): Promise<AcceptanceReview> {
    return this.serialized(async () => {
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new AcceptanceError(400, "INVALID_ACCEPTANCE_INVALIDATION", "Invalidation reason is required");
    if (normalizedReason.length > MAX_COMMENT_LENGTH) {
      throw new AcceptanceError(400, "INVALID_ACCEPTANCE_INVALIDATION", `Invalidation reason cannot exceed ${MAX_COMMENT_LENGTH} characters`);
    }
    const fingerprint = canonicalJson({ op: "invalidate", id, actorId, reason: normalizedReason });
    return this.idempotent(idempotencyKey, fingerprint, async () => {
      const review = await this.requiredReview(id);
      if (review.state === "superseded") {
        throw new AcceptanceError(409, "ACCEPTANCE_REVIEW_SUPERSEDED", "Superseded reviews are already not current");
      }
      if (review.state === "invalidated") {
        throw new AcceptanceError(409, "ACCEPTANCE_REVIEW_INVALIDATED", "Review is already invalidated");
      }
      const invalidatedAt = this.isoNow();
      const changed = {
        ...review,
        state: "invalidated" as const,
        invalidatedAt,
        invalidatedBy: actorId,
        invalidationReason: normalizedReason,
      };
      await this.commitReviewMutation(idempotencyKey, fingerprint, changed, changed, {
        actorId,
        reason: normalizedReason,
        occurredAt: invalidatedAt,
      });
      return changed;
    });
    });
  }

  async verify(
    id: string,
    expected: VerifyExpected,
    eligibleReviewers?: string[],
  ): Promise<AcceptanceVerifyResult> {
    return this.serialized(async () => {
    const review = await this.requiredReview(id);
    const current = await this.reconcileForRead(review, eligibleReviewers);
    const currentId = await this.store.getCurrentId(current.subject, current.gate);
    const base = {
      receipt: current.receipt,
      reviewId: current.id,
      revision: current.revision,
      manifestHash: current.manifestHash,
    };
    if (expected.subject !== undefined && expected.subject !== current.subject) {
      return { ...base, satisfied: false, state: current.state, reason: "subject_mismatch" };
    }
    if (expected.gate !== undefined && expected.gate !== current.gate) {
      return { ...base, satisfied: false, state: current.state, reason: "gate_mismatch" };
    }
    if (expected.manifestHash !== current.manifestHash) {
      return { ...base, satisfied: false, state: current.state, reason: "manifest_hash_mismatch" };
    }
    if (expected.commit !== undefined && expected.commit !== current.manifest.build.commit) {
      return { ...base, satisfied: false, state: current.state, reason: "commit_mismatch" };
    }
    if (currentId !== current.id) {
      return { ...base, satisfied: false, state: current.state, reason: "not_current" };
    }
    if (current.state !== "approved") {
      return { ...base, satisfied: false, state: current.state, reason: "not_approved" };
    }
    if (!current.receipt) {
      return { ...base, satisfied: false, state: current.state, reason: "missing_receipt" };
    }
    return { ...base, satisfied: true, state: current.state };
    });
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(action, action);
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async idempotent<T>(key: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
    if (!key.trim()) throw new AcceptanceError(400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key is required");
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new AcceptanceError(400, "INVALID_IDEMPOTENCY_KEY", `Idempotency-Key cannot exceed ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }
    const existing = await this.store.getIdempotency(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AcceptanceError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different mutation");
      }
      return existing.result as T;
    }
    return action();
  }

  private async requiredReview(id: string): Promise<AcceptanceReview> {
    const review = await this.store.getReview(id);
    if (!review) throw new AcceptanceError(404, "ACCEPTANCE_REVIEW_NOT_FOUND", "Acceptance review was not found");
    return review;
  }

  private async prepareEditableReview(id: string, eligibleReviewers?: string[]): Promise<AcceptanceReview> {
    const review = await this.requiredReview(id);
    const changed = this.reconcileReview(review, eligibleReviewers);
    if (changed !== review) {
      await this.store.commit({ reviews: [changed], events: [await this.eventFor(changed)] });
    }
    return changed;
  }

  private async reconcileForRead(review: AcceptanceReview, eligibleReviewers?: string[]): Promise<AcceptanceReview> {
    const changed = this.reconcileReview(review, eligibleReviewers);
    if (changed !== review) {
      await this.store.commit({ reviews: [changed], events: [await this.eventFor(changed)] });
    }
    return changed;
  }

  private reconcileReview(review: AcceptanceReview, eligibleReviewers?: string[]): AcceptanceReview {
    if (review.state !== "pending" && review.state !== "approved") return review;
    let changed = review;
    if (new Date(review.expiresAt).getTime() <= this.clock.now().getTime()) {
      changed = { ...changed, state: "expired", expiredAt: this.isoNow() };
    }
    if (eligibleReviewers !== undefined && changed.state === "pending") {
      const eligible = distinctStrings(eligibleReviewers);
      const votes = changed.votes.filter((vote) => eligible.includes(vote.actorId));
      if (votes.length !== changed.votes.length) changed = { ...changed, votes };
    }
    return changed;
  }

  private async settleAfterDecision(review: AcceptanceReview): Promise<AcceptanceReview> {
    if (review.votes.some((vote) => vote.decision === "reject")) return { ...review, state: "rejected" };
    if (review.votes.some((vote) => vote.decision === "request_revision")) return { ...review, state: "revision_requested" };
    const criteriaIds = review.manifest.criteria.map((criterion) => criterion.id);
    const approvedVotes = review.votes.filter((vote) => vote.decision === "approve");
    const hasQuorum = criteriaIds.every((criterionId) =>
      approvedVotes.filter((vote) => vote.criteriaIds.includes(criterionId)).length >= review.policy.quorum,
    );
    if (!hasQuorum) return review;
    const approved = { ...review, state: "approved" as const };
    return { ...approved, receipt: await this.signApprovedReview(approved) };
  }

  private async signApprovedReview(review: AcceptanceReview): Promise<string> {
    if (!this.signReceipt) throw new Error("Acceptance receipt signer is not configured");
    return this.signReceipt(review);
  }

  private async commitReviewMutation(
    idempotencyKey: string,
    fingerprint: string,
    result: AcceptanceReview,
    review: AcceptanceReview,
    eventContext: AcceptanceEventContext = {},
  ): Promise<void> {
    await this.store.commit({
      idempotency: { key: idempotencyKey, fingerprint, result },
      reviews: [review],
      events: [await this.eventFor(review, eventContext)],
    });
  }

  async expireDueReviews(): Promise<number> {
    return this.serialized(async () => {
      const reviews = await this.store.listReviews();
      const changedReviews: AcceptanceReview[] = [];
      const events: AcceptanceEvent[] = [];
      for (const review of reviews) {
        const changed = this.reconcileReview(review);
        if (changed !== review && changed.state === "expired") {
          changedReviews.push(changed);
          events.push(await this.eventFor(changed, { reason: "expired", occurredAt: changed.expiredAt }));
        }
      }
      if (changedReviews.length > 0) await this.store.commit({ reviews: changedReviews, events });
      return changedReviews.length;
    });
  }

  private async eventFor(review: AcceptanceReview, context: AcceptanceEventContext = {}): Promise<AcceptanceEvent> {
    return {
      id: this.ids.randomId(),
      type: "acceptance.changed",
      projectId: review.projectId,
      reviewId: review.id,
      subject: review.subject,
      gate: review.gate,
      revision: review.revision,
      sequence: await this.store.nextSequence(),
      state: review.state,
      manifestHash: review.manifestHash,
      occurredAt: context.occurredAt ?? this.isoNow(),
      receipt: review.receipt,
      manifest: review.manifest,
      ...(context.actorId === undefined ? {} : { actorId: context.actorId }),
      ...(context.reason === undefined ? {} : { reason: context.reason }),
      ...(review.supersededBy === undefined ? {} : { supersededBy: review.supersededBy }),
      ...(review.invalidatedAt === undefined ? {} : { invalidatedAt: review.invalidatedAt }),
      ...(review.invalidatedBy === undefined ? {} : { invalidatedBy: review.invalidatedBy }),
      ...(review.invalidationReason === undefined ? {} : { invalidationReason: review.invalidationReason }),
      ...(review.expiredAt === undefined ? {} : { expiredAt: review.expiredAt }),
    };
  }

  private assertPending(review: AcceptanceReview): void {
    if (review.state !== "pending") {
      throw new AcceptanceError(409, "ACCEPTANCE_REVIEW_TERMINAL", "Terminal acceptance reviews cannot be edited");
    }
  }

  private assertKnownCriteria(review: AcceptanceReview, criteriaIds: string[]): void {
    const known = new Set(review.manifest.criteria.map((criterion) => criterion.id));
    const unique = new Set(criteriaIds);
    if (unique.size !== criteriaIds.length || criteriaIds.some((criterionId) => !known.has(criterionId))) {
      throw new AcceptanceError(400, "INVALID_ACCEPTANCE_DECISION", "Decision criteriaIds must reference each criterion at most once");
    }
  }

  private assertApprovesEveryCriterion(review: AcceptanceReview, criteriaIds: string[]): void {
    const expected = review.manifest.criteria.map((criterion) => criterion.id).sort();
    const actual = [...criteriaIds].sort();
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
      throw new AcceptanceError(400, "INVALID_ACCEPTANCE_DECISION", "Approval must acknowledge every criterion");
    }
  }

  private isoNow(): string {
    return this.clock.now().toISOString();
  }
}

export class AcceptanceCoordinator extends DurableObject<AcceptanceCoordinatorEnv> {
  private readonly store: SqlAcceptanceStore;
  private readonly core: AcceptanceCore;

  constructor(state: DurableObjectState, env: AcceptanceCoordinatorEnv) {
    super(state, env);
    const storage = this.ctx.storage as unknown as AcceptanceSqlStorage;
    initializeAcceptanceSqlStorage(storage);
    this.store = new SqlAcceptanceStore(storage);
    this.core = new AcceptanceCore(this.store, {
      signReceipt: (review) => signAcceptanceReceipt(review, env),
    });
  }

  publish(manifest: AcceptanceManifest, context: PublishContext, idempotencyKey: string): Promise<AcceptanceReview> {
    return this.core.publish(manifest, context, idempotencyKey);
  }

  getReview(id: string, eligibleReviewers?: string[]): Promise<AcceptanceReview | undefined> {
    return this.core.getReview(id, eligibleReviewers);
  }

  listReviews(eligibleReviewers?: string[]): Promise<AcceptanceReview[]> {
    return this.core.listReviews(eligibleReviewers);
  }

  getCurrent(subject: string, gate: string, eligibleReviewers?: string[]): Promise<AcceptanceReview | null> {
    return this.core.getCurrent(subject, gate, eligibleReviewers);
  }

  decide(
    id: string,
    input: DecisionInput,
    context: { actorId: string; eligibleReviewers: string[] },
    key: string,
  ): Promise<AcceptanceReview> {
    return this.core.decide(id, input, context, key);
  }

  comment(id: string, text: string, actorId: string, key: string): Promise<AcceptanceReview> {
    return this.core.comment(id, text, actorId, key);
  }

  openPreview(id: string, actorId: string, key: string): Promise<AcceptanceReview> {
    return this.core.openPreview(id, actorId, key);
  }

  invalidate(id: string, reason: string, actorId: string, key: string): Promise<AcceptanceReview> {
    return this.core.invalidate(id, reason, actorId, key);
  }

  verify(id: string, expected: VerifyExpected, eligibleReviewers?: string[]): Promise<AcceptanceVerifyResult> {
    return this.core.verify(id, expected, eligibleReviewers);
  }

  async alarm(): Promise<void> {
    await this.core.expireDueReviews();
    await flushAcceptanceOutbox(this.store, this.env.ACCEPTANCE_EVENTS);
    await this.store.scheduleNextAlarm();
  }
}

export function initializeAcceptanceSqlStorage(storage: AcceptanceSqlStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS acceptance_reviews (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      gate TEXT NOT NULL,
      revision INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS acceptance_reviews_subject_gate_revision
      ON acceptance_reviews(subject, gate, revision);
    CREATE TABLE IF NOT EXISTS acceptance_current (
      subject TEXT NOT NULL,
      gate TEXT NOT NULL,
      review_id TEXT NOT NULL,
      PRIMARY KEY(subject, gate)
    );
    CREATE TABLE IF NOT EXISTS acceptance_idempotency (
      key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS acceptance_outbox (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS acceptance_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      next_sequence INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO acceptance_meta(singleton, next_sequence) VALUES (1, 1);
  `);
}

export class SqlAcceptanceStore implements AcceptanceStore {
  constructor(private readonly storage: AcceptanceSqlStorage) {}

  async getReview(id: string): Promise<AcceptanceReview | undefined> {
    const row = this.storage.sql.exec<{ record: string }>(
      "SELECT record FROM acceptance_reviews WHERE id = ?",
      id,
    ).toArray()[0];
    return row ? JSON.parse(row.record) as AcceptanceReview : undefined;
  }

  async listReviews(): Promise<AcceptanceReview[]> {
    return this.storage.sql.exec<{ record: string }>(
      "SELECT record FROM acceptance_reviews ORDER BY revision DESC, id DESC",
    ).toArray().map((row) => JSON.parse(row.record) as AcceptanceReview);
  }

  async getCurrentId(subject: string, gate: string): Promise<string | undefined> {
    return this.storage.sql.exec<{ review_id: string }>(
      "SELECT review_id FROM acceptance_current WHERE subject = ? AND gate = ?",
      subject,
      gate,
    ).toArray()[0]?.review_id;
  }

  async getIdempotency(key: string): Promise<{ fingerprint: string; result: unknown } | undefined> {
    const row = this.storage.sql.exec<{ fingerprint: string; result: string }>(
      "SELECT fingerprint, result FROM acceptance_idempotency WHERE key = ?",
      key,
    ).toArray()[0];
    return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) } : undefined;
  }

  async nextSequence(): Promise<number> {
    const row = this.storage.sql.exec<{ next_sequence: number }>(
      "SELECT next_sequence FROM acceptance_meta WHERE singleton = 1",
    ).one();
    this.storage.sql.exec(
      "UPDATE acceptance_meta SET next_sequence = ? WHERE singleton = 1",
      row.next_sequence + 1,
    );
    return row.next_sequence;
  }

  async commit(mutation: AcceptanceMutation): Promise<void> {
    this.storage.transactionSync(() => {
      for (const review of mutation.reviews ?? []) {
        this.storage.sql.exec(
          "INSERT OR REPLACE INTO acceptance_reviews(id, subject, gate, revision, record) VALUES (?, ?, ?, ?, ?)",
          review.id,
          review.subject,
          review.gate,
          review.revision,
          JSON.stringify(review),
        );
      }
      for (const current of mutation.current ?? []) {
        this.storage.sql.exec(
          "INSERT OR REPLACE INTO acceptance_current(subject, gate, review_id) VALUES (?, ?, ?)",
          current.subject,
          current.gate,
          current.reviewId,
        );
      }
      for (const event of mutation.events ?? []) {
        this.storage.sql.exec(
          "INSERT OR REPLACE INTO acceptance_outbox(id, sequence, payload, created_at) VALUES (?, ?, ?, ?)",
          event.id,
          event.sequence,
          JSON.stringify(event),
          event.occurredAt,
        );
      }
      if (mutation.idempotency) {
        this.storage.sql.exec(
          "INSERT INTO acceptance_idempotency(key, fingerprint, result, created_at) VALUES (?, ?, ?, ?)",
          mutation.idempotency.key,
          mutation.idempotency.fingerprint,
          JSON.stringify(mutation.idempotency.result),
          new Date().toISOString(),
        );
      }
    });
    await this.scheduleNextAlarm();
  }

  async listOutbox(limit: number): Promise<AcceptanceEvent[]> {
    return this.storage.sql.exec<{ payload: string }>(
      "SELECT payload FROM acceptance_outbox ORDER BY sequence LIMIT ?",
      limit,
    ).toArray().map((row) => JSON.parse(row.payload) as AcceptanceEvent);
  }

  async deleteOutbox(id: string): Promise<void> {
    this.storage.sql.exec("DELETE FROM acceptance_outbox WHERE id = ?", id);
  }

  async scheduleNextAlarm(): Promise<void> {
    if (!this.storage.setAlarm) return;
    if ((await this.listOutbox(1)).length > 0) {
      await this.storage.setAlarm(Date.now() + 1_000);
      return;
    }
    const activeExpiries = (await this.listReviews())
      .filter((review) => review.state === "pending" || review.state === "approved")
      .map((review) => Date.parse(review.expiresAt))
      .filter((time) => Number.isFinite(time));
    if (activeExpiries.length > 0) await this.storage.setAlarm(Math.min(...activeExpiries));
  }
}

export async function flushAcceptanceOutbox(store: AcceptanceStore, queue: Queue<AcceptanceEvent>): Promise<void> {
  const events = await store.listOutbox(32);
  for (const event of events) {
    try {
      await queue.send(event);
      await store.deleteOutbox(event.id);
    } catch (error) {
      await store.scheduleNextAlarm?.();
      throw error;
    }
  }
}

function normalizeDecisionInput(input: DecisionInput): DecisionInput {
  if (input.decision !== "approve" && input.decision !== "reject" && input.decision !== "request_revision") {
    throw new AcceptanceError(400, "INVALID_ACCEPTANCE_DECISION", "Decision must be approve, reject, or request_revision");
  }
  if (!Array.isArray(input.criteriaIds) || !input.criteriaIds.every((id) => typeof id === "string" && id.trim() !== "")) {
    throw new AcceptanceError(400, "INVALID_ACCEPTANCE_DECISION", "Decision criteriaIds must be an array of strings");
  }
  if (input.comment !== undefined && (typeof input.comment !== "string" || input.comment.length > MAX_COMMENT_LENGTH)) {
    throw new AcceptanceError(400, "INVALID_ACCEPTANCE_DECISION", `Decision comment cannot exceed ${MAX_COMMENT_LENGTH} characters`);
  }
  const comment = input.comment?.trim();
  if (input.decision !== "approve" && !comment) {
    throw new AcceptanceError(400, "INVALID_ACCEPTANCE_DECISION", "Reject and revision decisions require a comment");
  }
  return {
    decision: input.decision,
    ...(comment === undefined ? {} : { comment }),
    criteriaIds: [...input.criteriaIds],
  };
}

function distinctNonEmpty(values: string[], label: string): string[] {
  if (!Array.isArray(values)) throw new AcceptanceError(400, "INVALID_ACCEPTANCE_CONTEXT", `${label} must be an array`);
  const distinct = [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== ""))];
  if (distinct.length === 0) throw new AcceptanceError(400, "INVALID_ACCEPTANCE_CONTEXT", `${label} are required`);
  return distinct;
}

function distinctStrings(values: string[]): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== ""))];
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}
