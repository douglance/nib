import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptanceError, DEFAULT_ACCEPTANCE_TTL_SECONDS, parseAcceptanceError, type DecisionInput } from "./contracts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { AcceptanceCore } from "./coordinator";
import { ManualClock, MemoryAcceptanceStore, manifest, PredictableIds } from "./core-test-helpers";

let clock: ManualClock;
let store: MemoryAcceptanceStore;
let core: AcceptanceCore;

beforeEach(() => {
  clock = new ManualClock();
  store = new MemoryAcceptanceStore();
  core = new AcceptanceCore(store, {
    clock,
    ids: new PredictableIds(),
    signReceipt: async (review) => `receipt:${review.id}:${review.manifestHash}`,
  });
});

describe("acceptance coordinator core", () => {
  it("publishes with the default 7 day TTL and supersedes the prior current revision", async () => {
    const first = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-1");

    expect(first.state).toBe("pending");
    expect(first.policy).toEqual({ quorum: 1, ttlSeconds: DEFAULT_ACCEPTANCE_TTL_SECONDS });
    expect(new Date(first.expiresAt).getTime() - new Date(first.createdAt).getTime()).toBe(DEFAULT_ACCEPTANCE_TTL_SECONDS * 1_000);

    const approved = await core.decide(first.id, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-b"],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1"],
    }, "approve-1");
    expect(approved.state).toBe("approved");
    expect(approved.receipt).toBe(`receipt:${first.id}:${first.manifestHash}`);

    const second = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-2");

    expect(second.revision).toBe(2);
    const superseded = await core.getReview(first.id);
    expect(superseded?.state).toBe("superseded");
    expect(superseded?.supersededBy).toBe(second.id);
    expect((await core.getCurrent("homepage", "visual-acceptance"))?.id).toBe(second.id);
    await expect(core.verify(first.id, { manifestHash: first.manifestHash })).resolves.toMatchObject({
      satisfied: false,
      state: "superseded",
      reason: "not_current",
    });
  });

  it("requires distinct approval quorum for every criterion", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
      policy: { quorum: 2 },
    }, "publish-quorum");

    await expect(core.decide(review.id, {
      decision: "approve",
      criteriaIds: ["criterion-a"],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
    }, "approve-missing-criterion")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 400 && parsed.code === "INVALID_ACCEPTANCE_DECISION";
    });

    await expect(core.decide(review.id, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-a", "criterion-b"],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
    }, "approve-duplicate-criterion")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 400 && parsed.code === "INVALID_ACCEPTANCE_DECISION";
    });

    const oneApproval = await core.decide(review.id, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-b"],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
    }, "approve-reviewer-1");
    expect(oneApproval.state).toBe("pending");

    await expect(core.decide(review.id, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-b"],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
    }, "approve-reviewer-1-again")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 409 && parsed.code === "ACCEPTANCE_DECISION_ALREADY_RECORDED";
    });

    const approved = await core.decide(review.id, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-b"],
    }, {
      actorId: "reviewer-2",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
    }, "approve-reviewer-2");
    expect(approved.state).toBe("approved");
    expect(approved.votes.map((vote) => vote.actorId)).toEqual(["reviewer-1", "reviewer-2"]);
  });

  it("treats comments and preview opens as nonterminal events while vetoes and revision requests settle", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
      policy: { quorum: 2 },
    }, "publish-veto");

    const commented = await core.comment(review.id, "Looks close", "reviewer-1", "comment-1");
    expect(commented.state).toBe("pending");
    expect(commented.comments).toHaveLength(1);

    const opened = await core.openPreview(review.id, "reviewer-1", "open-preview-1");
    expect(opened.state).toBe("pending");
    expect(opened.votes).toHaveLength(0);

    const rejected = await core.decide(review.id, {
      decision: "reject",
      comment: "Blocks release",
      criteriaIds: [],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
    }, "reject-1");
    expect(rejected.state).toBe("rejected");

    await expect(core.comment(review.id, "late", "reviewer-2", "late-comment")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 409 && parsed.code === "ACCEPTANCE_REVIEW_TERMINAL";
    });

    const revisionReview = await core.publish(manifest({ subject: "settings" }), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-revision-request");
    const revisionRequested = await core.decide(revisionReview.id, {
      decision: "request_revision",
      comment: "Needs another pass",
      criteriaIds: [],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1"],
    }, "request-revision-1");
    expect(revisionRequested.state).toBe("revision_requested");
  });

  it("serializes concurrent distinct approvals so quorum retains both votes", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
      policy: { quorum: 2 },
    }, "publish-concurrent-approvals");

    const [first, second] = await Promise.all([
      core.decide(review.id, {
        decision: "approve",
        criteriaIds: ["criterion-a", "criterion-b"],
      }, {
        actorId: "reviewer-1",
        eligibleReviewers: ["reviewer-1", "reviewer-2"],
      }, "approve-concurrent-1"),
      core.decide(review.id, {
        decision: "approve",
        criteriaIds: ["criterion-a", "criterion-b"],
      }, {
        actorId: "reviewer-2",
        eligibleReviewers: ["reviewer-1", "reviewer-2"],
      }, "approve-concurrent-2"),
    ]);

    expect([first.state, second.state]).toContain("approved");
    const stored = await core.getReview(review.id);
    expect(stored?.state).toBe("approved");
    expect(stored?.votes.map((vote) => vote.actorId).sort()).toEqual(["reviewer-1", "reviewer-2"]);
  });

  it("serializes concurrent comments so distinct keys retain both comments", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-concurrent-comments");

    await Promise.all([
      core.comment(review.id, "first", "reviewer-1", "comment-concurrent-1"),
      core.comment(review.id, "second", "reviewer-2", "comment-concurrent-2"),
    ]);

    expect((await core.getReview(review.id))?.comments.map((comment) => comment.text).sort()).toEqual(["first", "second"]);
  });

  it("serializes publish and decide against the current revision without losing the settled old review", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-before-race");

    const [decision, publication] = await Promise.all([
      core.decide(review.id, {
        decision: "approve",
        criteriaIds: ["criterion-a", "criterion-b"],
      }, {
        actorId: "reviewer-1",
        eligibleReviewers: ["reviewer-1"],
      }, "approve-during-publish"),
      core.publish(manifest(), {
        actorId: "publisher",
        eligibleReviewers: ["reviewer-1"],
      }, "publish-during-decision"),
    ]);

    expect(decision.state).toBe("approved");
    expect(publication.revision).toBe(2);
    expect((await core.getReview(review.id))?.state).toBe("superseded");
    expect((await core.getReview(review.id))?.votes).toHaveLength(1);
    expect((await core.getCurrent("homepage", "visual-acceptance"))?.id).toBe(publication.id);
  });

  it("serializes reconciliation reads with mutations so pruning does not drop comments", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
      policy: { quorum: 2 },
    }, "publish-reconcile-race");
    await core.decide(review.id, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-b"],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
    }, "approve-before-reconcile-race");

    await Promise.all([
      core.getReview(review.id, ["reviewer-2"]),
      core.comment(review.id, "keep this comment", "reviewer-2", "comment-during-reconcile"),
    ]);

    const stored = await core.getReview(review.id);
    expect(stored?.votes).toEqual([]);
    expect(stored?.comments.map((comment) => comment.text)).toEqual(["keep this comment"]);
  });

  it("prunes pending votes against live reviewer eligibility on reads and verify fails closed", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
      policy: { quorum: 2 },
    }, "publish-prune");

    await core.decide(review.id, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-b"],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
    }, "approve-before-revoke");

    const pruned = await core.getReview(review.id, ["reviewer-2"]);
    expect(pruned?.votes).toEqual([]);
    expect((await core.getReview(review.id))?.votes).toEqual([]);
    expect((await core.listReviews(["reviewer-2"]))[0]?.votes).toEqual([]);
    await expect(core.verify(review.id, { manifestHash: review.manifestHash }, ["reviewer-2"])).resolves.toMatchObject({
      satisfied: false,
      state: "pending",
      reason: "not_approved",
    });
  });

  it("expires pending reviews and invalidates approved current reviews without erasing receipts", async () => {
    const expiring = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
      policy: { ttlSeconds: 1 },
    }, "publish-expiring");
    clock.advanceSeconds(2);

    expect((await core.getReview(expiring.id))?.state).toBe("expired");
    await expect(core.comment(expiring.id, "too late", "reviewer-1", "comment-expired")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 409 && parsed.code === "ACCEPTANCE_REVIEW_TERMINAL";
    });

    const approvable = await core.publish(manifest({ subject: "billing" }), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-invalidation");
    const approved = await core.decide(approvable.id, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-b"],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1"],
    }, "approve-invalidation");
    const invalidated = await core.invalidate(approved.id, "Deployment rolled back", "publisher", "invalidate-1");

    expect(invalidated.state).toBe("invalidated");
    expect(invalidated.receipt).toBe(approved.receipt);
    expect(invalidated.invalidatedAt).toBe(clock.now().toISOString());
    expect(invalidated.invalidatedBy).toBe("publisher");
    expect(invalidated.invalidationReason).toBe("Deployment rolled back");
    const invalidationEvent = (await store.listOutbox(20)).find((event) => event.state === "invalidated");
    expect(invalidationEvent).toMatchObject({
      actorId: "publisher",
      reason: "Deployment rolled back",
      invalidatedAt: invalidated.invalidatedAt,
      invalidatedBy: "publisher",
      invalidationReason: "Deployment rolled back",
    });
    await expect(core.verify(approved.id, { manifestHash: approved.manifestHash })).resolves.toMatchObject({
      satisfied: false,
      state: "invalidated",
      reason: "not_approved",
    });
  });

  it("fails closed for approved reviews after their TTL expires", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
      policy: { ttlSeconds: 1 },
    }, "publish-approved-expiry");
    const approved = await core.decide(review.id, {
      decision: "approve",
      criteriaIds: ["criterion-a", "criterion-b"],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1"],
    }, "approve-before-expiry");
    clock.advanceSeconds(2);

    expect((await core.getReview(approved.id))?.state).toBe("expired");
    await expect(core.verify(approved.id, { manifestHash: approved.manifestHash })).resolves.toMatchObject({
      satisfied: false,
      state: "expired",
      reason: "not_approved",
    });
  });


  it("expires due reviews from the alarm path without a read", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
      policy: { ttlSeconds: 1 },
    }, "publish-alarm-expiry");
    for (const event of await store.listOutbox(10)) await store.deleteOutbox(event.id);

    clock.advanceSeconds(2);
    await expect(core.expireDueReviews()).resolves.toBe(1);

    const events = await store.listOutbox(10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reviewId: review.id,
      state: "expired",
      reason: "expired",
      expiredAt: clock.now().toISOString(),
    });
    expect((await store.getReview(review.id))?.state).toBe("expired");
  });

  it("returns identical idempotent results and rejects idempotency conflicts", async () => {
    const published = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "same-key");
    const replay = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "same-key");
    expect(replay.id).toBe(published.id);

    await expect(core.publish(manifest({ subject: "different" }), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "same-key")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 409 && parsed.code === "IDEMPOTENCY_CONFLICT";
    });

    await expect(core.publish(manifest(), {
      actorId: "different-publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "same-key")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 409 && parsed.code === "IDEMPOTENCY_CONFLICT";
    });
  });

  it("rejects malformed decision enums and overlarge manifests at the core boundary", async () => {
    await expect(core.publish(manifest({ title: "x".repeat(513) }), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-too-large")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 400 && parsed.code === "INVALID_ACCEPTANCE_MANIFEST";
    });

    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-malformed-decision");
    await expect(core.decide(review.id, {
      decision: "maybe",
      criteriaIds: ["criterion-a", "criterion-b"],
    } as unknown as DecisionInput, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1"],
    }, "bad-decision")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 400 && parsed.code === "INVALID_ACCEPTANCE_DECISION";
    });

    await expect(core.decide(review.id, {
      decision: "reject",
      criteriaIds: [],
    }, {
      actorId: "reviewer-1",
      eligibleReviewers: ["reviewer-1"],
    }, "reject-without-comment")).rejects.toSatisfy((error: unknown) => {
      const parsed = parseAcceptanceError(error);
      return parsed?.status === 400 && parsed.code === "INVALID_ACCEPTANCE_DECISION";
    });
  });

  it("keeps a durable outbox event for each mutation until flushed", async () => {
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-outbox");
    await core.comment(review.id, "Ready to inspect", "reviewer-1", "comment-outbox");
    await core.openPreview(review.id, "reviewer-1", "open-outbox");

    const events = await store.listOutbox(10);
    expect(events.map((event) => event.state)).toEqual(["pending", "pending", "pending"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);

    await store.deleteOutbox(events[0]!.id);
    expect(await store.listOutbox(10)).toHaveLength(2);
  });
});

describe("acceptance errors", () => {
  it("encode status and code in the message for Durable Object RPC boundaries", () => {
    const error = new AcceptanceError(403, "ACCEPTANCE_REVIEWER_NOT_ELIGIBLE", "Actor is not eligible");
    expect(error.message).toMatch(/^NIB_ACCEPTANCE_ERROR:/);
    expect(parseAcceptanceError(new Error(error.message))).toEqual({
      status: 403,
      code: "ACCEPTANCE_REVIEWER_NOT_ELIGIBLE",
      message: "Actor is not eligible",
    });
  });
});
