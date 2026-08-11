import { describe, expect, it } from "vitest";
import {
  HostedRequestCoreService,
  MemoryKeyValueStore,
  MemoryMediaStore,
  REVIEW_SESSION_COOKIE,
  type ContinuationDelivery,
  createHostedRequestCoreForTest
} from "./hosted-request-core";
import { reviewPageHeaders, reviewPageHtml } from "./review-page";
import { R2MediaStore } from "./r2-media-store";
import { publicTenantId, stubForTenant, trustedTenantId } from "./tenant-routing";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("hosted request core", () => {
  it("creates requests idempotently and records replayable request events", async () => {
    const core = createHostedRequestCoreForTest();

    const first = await core.createRequest(
      { title: "Approve homepage", prompt: "Ship this visual change?", choices: ["Approve", "Reject"] },
      { idempotencyKey: "create-homepage" }
    );
    const firstBody = await readJson(first);

    expect(first.status).toBe(201);
    expect(firstBody.request).toMatchObject({
      formatVersion: "1.0",
      revision: 1,
      title: "Approve homepage",
      prompt: "Ship this visual change?",
      status: "pending",
      reviewable: true,
      source: { type: "hosted" },
      decision: { type: "approval" },
      choices: ["Approve", "Reject"]
    });
    assertCanonicalRequestShape(firstBody.request as Record<string, unknown>);
    expect(firstBody.status).toBe("pending");
    expect(firstBody.reviewLink).toMatch(new RegExp(`^/r/${(firstBody.request as { id: string }).id}#token=nib_review_`));
    expect(JSON.stringify(firstBody.request)).not.toContain("nib_review_");

    const replay = await core.createRequest(
      { title: "Approve homepage", prompt: "Ship this visual change?", choices: ["Approve", "Reject"] },
      { idempotencyKey: "create-homepage" }
    );
    const replayBody = await readJson(replay);

    expect(replay.headers.get("x-nib-idempotent-replay")).toBe("true");
    expect(replayBody).toEqual(firstBody);

    const events = await core.listEvents({ after: "0" });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({ type: "request.created", cursor: "1" });
  });

  it("accepts and returns canonical protocol request fields without dropping legacy fields", async () => {
    const core = createHostedRequestCoreForTest();

    const created = await readJson(await core.createRequest({
      formatVersion: "1.0",
      title: "Canonical review",
      description: "Canonical description",
      prompt: "Review the canonical payload",
      source: { type: "agent", id: "codex" },
      subject: { type: "pull_request", id: "123", title: "PR 123" },
      artifacts: [{
        id: "walkthrough",
        type: "video",
        source: {
          type: "external",
          url: "https://cdn.example.test/walkthrough.mp4",
          sha256: "a".repeat(64),
          byteLength: 2048
        }
      }],
      decision: { type: "approval", prompt: "Ship this?" },
      routing: { target: "public-cloudflare" },
      policy: { responseRequired: true },
      continuation: { type: "webhook", url: "https://hooks.test/review", secret: "must-not-be-stored" },
      metadata: { traceId: "trace-1" }
    }, { idempotencyKey: "canonical-create" }));

    expect(created.request).toMatchObject({
      formatVersion: "1.0",
      revision: 1,
      title: "Canonical review",
      description: "Canonical description",
      prompt: "Review the canonical payload",
      status: "pending",
      reviewable: true,
      source: { type: "agent", id: "codex" },
      subject: { type: "pull_request", id: "123", title: "PR 123" },
      artifacts: [expect.objectContaining({ id: "walkthrough", type: "video" })],
      decision: { type: "approval", prompt: "Ship this?" },
      routing: { target: "public-cloudflare" },
      policy: { responseRequired: true },
      continuation: { type: "webhook", configured: true },
      metadata: { traceId: "trace-1" }
    });
    assertCanonicalRequestShape(created.request as Record<string, unknown>);
    expect(JSON.stringify(created.request)).not.toContain("must-not-be-stored");
    expect(JSON.stringify(created.request)).not.toContain("https://hooks.test/review");
  });

  it("rejects unsupported major protocol versions and missing canonical source type", async () => {
    const core = createHostedRequestCoreForTest();

    const unsupported = await readJson(await core.createRequest({
      formatVersion: "2.0",
      title: "Unsupported"
    }, { idempotencyKey: "unsupported-major" }));
    expect(unsupported.error).toBe("Unsupported request formatVersion major");

    const missingSourceType = await readJson(await core.createRequest({
      title: "Bad source",
      source: { system: "codex" }
    }, { idempotencyKey: "missing-source-type" }));
    expect(missingSourceType.error).toBe("source.type is required");
  });

  it("mints replay-stable default review links only on non-draft creation", async () => {
    const core = createHostedRequestCoreForTest();
    const created = await readJson(await core.createRequest({ title: "Guest ready" }, { idempotencyKey: "default-link" }));
    const replay = await readJson(await core.createRequest({ title: "Guest ready" }, { idempotencyKey: "default-link" }));
    const request = created.request as { id: string };

    expect(created.reviewLink).toEqual(replay.reviewLink);
    expect(created.reviewLink).toMatch(new RegExp(`^/r/${request.id}#token=nib_review_`));
    expect(JSON.stringify(created.request)).not.toContain("nib_review_");

    const snapshot = await readJson(await core.getRequest(request.id, undefined, "owner"));
    const listed = await core.listRequests();
    expect(JSON.stringify(snapshot)).not.toContain("nib_review_");
    expect(JSON.stringify(listed)).not.toContain("nib_review_");

    const draft = await readJson(await core.createRequest({ title: "Draft guest", draft: true }, { idempotencyKey: "default-link-draft" }));
    expect(draft.reviewLink).toBeUndefined();
  });

  it("marks only trusted non-draft lifecycle states as reviewable for metering", async () => {
    const core = createHostedRequestCoreForTest();

    const spoofed = await readJson(await core.createRequest({
      title: "Spoof attempt",
      reviewable: false,
      metering: { firstReviewableRevision: 99, billable: false }
    }, { idempotencyKey: "metering-spoof" }));
    expect(spoofed.request).toMatchObject({
      status: "pending",
      reviewable: true,
      metering: {
        firstReviewableRevision: 1,
        currentReviewableRevision: 1
      }
    });

    const draft = await readJson(await core.createRequest({
      title: "Draft review",
      draft: true,
      reviewable: true
    }, { idempotencyKey: "metering-draft" }));
    expect(draft.request).toMatchObject({
      status: "draft",
      reviewable: false,
      metering: {
        firstReviewableRevision: null,
        currentReviewableRevision: null
      }
    });

    const request = draft.request as { id: string };
    const createdRevision = await readJson(await core.createRevision(request.id, {
      title: "Draft revision",
      draft: true
    }, { idempotencyKey: "metering-revision-draft", subject: "owner" }));
    expect(createdRevision.request).toMatchObject({
      revision: 2,
      status: "draft",
      reviewable: false
    });

    const published = await readJson(await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/revisions/2/publish`, {
      method: "POST",
      headers: { "idempotency-key": "metering-revision-publish" }
    }), { subject: "owner", origin: "https://nib.test" }));
    expect(published.request).toMatchObject({
      revision: 2,
      status: "pending",
      reviewable: true,
      metering: {
        firstReviewableRevision: 2,
        currentReviewableRevision: 2
      }
    });
  });

  it("rejects idempotency key reuse when the mutation payload changes", async () => {
    const core = createHostedRequestCoreForTest();

    await core.createRequest({ title: "First" }, { idempotencyKey: "same-key" });
    const conflict = await core.createRequest({ title: "Second" }, { idempotencyKey: "same-key" });
    const body = await readJson(conflict);

    expect(conflict.status).toBe(409);
    expect(body.error).toBe("Idempotency key reused with a different mutation");
  });

  it("stores revisions, decisions, feedback, and capability-scoped guest access", async () => {
    const core = createHostedRequestCoreForTest();
    const created = await readJson(await core.createRequest({ title: "Review copy" }, { idempotencyKey: "copy" }));
    const request = created.request as { id: string };

    const capability = await readJson(await core.createCapability(request.id, {
      scopes: ["view", "comment", "decide"],
      expiresAt: "2999-01-01T00:00:00.000Z"
    }, { idempotencyKey: "copy-guest" }));

    expect(capability.token).toMatch(/^nib_review_/);
    expect(capability.capability).toMatchObject({
      requestId: request.id,
      scopes: ["view", "comment", "decide"],
      revokedAt: null
    });
    expect(capability.link).toBe(`/r/${request.id}#token=${capability.token}`);
    expect(capability.link as string).not.toContain("?capability=");
    expect(JSON.stringify(capability.capability)).not.toContain(capability.token as string);

    const revision = await readJson(await core.createRevision(request.id, { title: "Review final copy" }, { idempotencyKey: "copy-rev" }));
    expect(revision.revision).toMatchObject({ number: 1, requestRevision: 2, patch: { title: "Review final copy" } });

    const decision = await readJson(await core.createDecision(request.id, { value: "approved", comment: "Looks right" }, {
      idempotencyKey: "copy-decision",
      capabilityToken: capability.token as string
    }));
    expect(decision.decision).toMatchObject({
      type: "decision",
      outcome: "approved",
      value: "approved",
      sequence: 1,
      requestRevision: 2,
      reviewer: { id: expect.any(String), type: expect.any(String) },
      comment: "Looks right"
    });

    const feedback = await readJson(await core.createFeedback(request.id, { kind: "comment", message: "Tighten the headline" }, {
      idempotencyKey: "copy-feedback",
      capabilityToken: capability.token as string
    }));
    expect(feedback.feedback).toMatchObject({ kind: "comment", message: "Tighten the headline" });

    await core.revokeCapability(request.id, (capability.capability as { id: string }).id, { idempotencyKey: "copy-revoke" });
    const denied = await core.createFeedback(request.id, { message: "late" }, {
      idempotencyKey: "copy-feedback-after-revoke",
      capabilityToken: capability.token as string
    });
    expect(denied.status).toBe(403);
  });

  it("increments stable request revisions, resets pending status, and keeps decision history", async () => {
    const core = createHostedRequestCoreForTest();
    const created = await readJson(await core.createRequest({ title: "Needs decision" }, { idempotencyKey: "rev-create" }));
    const request = created.request as { id: string };

    await core.createDecision(request.id, { outcome: "approved" }, { idempotencyKey: "rev-decision", subject: "owner" });
    const revised = await readJson(await core.createRevision(request.id, { title: "Needs second decision" }, {
      idempotencyKey: "rev-reset",
      subject: "owner"
    }));
    const decisions = await readJson(await core.listDecisions(request.id, undefined, "owner"));
    const events = await core.listEvents({ after: "0", requestId: request.id });

    expect(revised.request).toMatchObject({
      revision: 2,
      status: "pending",
      reviewable: false,
      decision: { type: "approval" },
      title: "Needs second decision"
    });
    expect((decisions.decisions as unknown[])).toHaveLength(1);
    expect(events.events.at(-1)).toMatchObject({
      type: "request.revised",
      requestRevision: 2,
      sequence: expect.any(Number),
      id: expect.any(String)
    });
  });

  it("hydrates legacy metering and preserves terminal cancellation state", async () => {
    const store = new MemoryKeyValueStore();
    const core = new HostedRequestCoreService(store, new MemoryMediaStore());
    const created = await readJson(await core.createRequest({ title: "Legacy request" }, {
      idempotencyKey: "legacy-create"
    }));
    const request = created.request as { id: string };
    const legacy = await store.get<Record<string, unknown>>(`request:${request.id}`);
    expect(legacy).toBeDefined();
    delete legacy?.metering;
    await store.put(`request:${request.id}`, legacy);

    const cancelled = await readJson(await core.createRevision(request.id, { status: "cancelled" }, {
      idempotencyKey: "legacy-cancel",
      subject: "owner"
    }));
    const stored = await store.get<Record<string, unknown>>(`request:${request.id}`);
    const events = await core.listEvents({ after: "0", requestId: request.id });

    expect(cancelled).toMatchObject({
      status: "cancelled",
      request: {
        status: "cancelled",
        reviewable: false,
        metering: {
          firstReviewableRevision: 1,
          currentReviewableRevision: null
        }
      }
    });
    expect(stored).toMatchObject({ status: "cancelled", resolvedAt: expect.any(String) });
    expect(events.events.at(-1)).toMatchObject({ type: "request.cancelled", requestRevision: 2 });
  });

  it("tracks artifact upload initiation, complete, and abort states", async () => {
    const core = createHostedRequestCoreForTest();
    const created = await readJson(await core.createRequest({ title: "Review asset" }, { idempotencyKey: "asset" }));
    const request = created.request as { id: string };

    const initiated = await readJson(await core.initiateArtifact(request.id, {
      name: "preview.png",
      contentType: "image/png",
      bytes: 4,
      sha256: await sha256Hex(new Uint8Array([1, 2, 3, 4]))
    }, { idempotencyKey: "asset-init" }));
    expect(initiated.artifact).toMatchObject({
      requestId: request.id,
      name: "preview.png",
      contentType: "image/png",
      bytes: 4,
      sha256: await sha256Hex(new Uint8Array([1, 2, 3, 4])),
      uploadMode: "single",
      status: "pending"
    });

    const rejected = await readJson(await core.completeArtifact(
      request.id,
      (initiated.artifact as { id: string }).id,
      new Uint8Array([1, 2, 3, 9]),
      { idempotencyKey: "asset-complete-bad-hash" }
    ));
    expect(rejected.error).toBe("Artifact SHA-256 does not match initiation");

    const completed = await readJson(await core.completeArtifact(
      request.id,
      (initiated.artifact as { id: string }).id,
      new Uint8Array([1, 2, 3, 4]),
      { idempotencyKey: "asset-complete" }
    ));
    expect(completed.artifact).toMatchObject({ status: "completed" });

    const second = await readJson(await core.initiateArtifact(request.id, {
      name: "scratch.txt",
      contentType: "text/plain",
      bytes: 5
    }, { idempotencyKey: "asset-init-2" }));
    const aborted = await readJson(await core.abortArtifact(
      request.id,
      (second.artifact as { id: string }).id,
      { idempotencyKey: "asset-abort" }
    ));
    expect(aborted.artifact).toMatchObject({ status: "aborted" });
  });

  it("declares explicit multipart part routes above the single-upload R2 threshold", async () => {
    const core = createHostedRequestCoreForTest();
    const created = await readJson(await core.createRequest({ title: "Large asset" }, { idempotencyKey: "large-asset" }));
    const request = created.request as { id: string };

    const initiated = await readJson(await core.initiateArtifact(request.id, {
      name: "large.mov",
      contentType: "video/quicktime",
      bytes: 100 * 1024 * 1024 + 1,
      sha256: "0".repeat(64)
    }, { idempotencyKey: "large-asset-init" }));

    expect(initiated.artifact).toMatchObject({
      uploadMode: "multipart",
      uploadId: expect.any(String),
      partSize: 32 * 1024 * 1024,
      sha256: "0".repeat(64)
    });
    expect((initiated.artifact as { parts: unknown[] }).parts).toEqual([
      expect.objectContaining({ number: 1, bytes: 32 * 1024 * 1024, url: expect.stringContaining("/parts/1"), status: "pending" }),
      expect.objectContaining({ number: 2, bytes: 32 * 1024 * 1024, url: expect.stringContaining("/parts/2"), status: "pending" }),
      expect.objectContaining({ number: 3, bytes: 32 * 1024 * 1024, url: expect.stringContaining("/parts/3"), status: "pending" }),
      expect.objectContaining({ number: 4, bytes: 4 * 1024 * 1024 + 1, url: expect.stringContaining("/parts/4"), status: "pending" })
    ]);
  });

  it("finalizes multipart uploads exactly once after every part passes integrity checks", async () => {
    const store = new MemoryKeyValueStore();
    const media = new MemoryMediaStore();
    const core = new HostedRequestCoreService(store, media);
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    bytes.fill(7, 0, 5 * 1024 * 1024);
    bytes[bytes.length - 1] = 9;
    const created = await readJson(await core.createRequest({ title: "Multipart final" }, { idempotencyKey: "multipart-final-create" }));
    const request = created.request as { id: string };
    const initiated = await readJson(await core.initiateArtifact(request.id, {
      name: "multipart.bin",
      contentType: "application/octet-stream",
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      partSize: 5 * 1024 * 1024,
      parts: [
        { number: 1, sha256: await sha256Hex(bytes.slice(0, 5 * 1024 * 1024)) },
        { number: 2, sha256: await sha256Hex(bytes.slice(5 * 1024 * 1024)) }
      ]
    }, { idempotencyKey: "multipart-final-init" }));
    const artifactId = (initiated.artifact as { id: string }).id;

    const missing = await readJson(await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/finalize`, {
      method: "POST",
      headers: { "idempotency-key": "multipart-final-missing" }
    }), { subject: "owner", origin: "https://nib.test" }));
    expect(missing.error).toBe("Multipart artifact has incomplete parts");

    const badPart = await readJson(await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/parts/1`, {
      method: "PUT",
      headers: { "idempotency-key": "multipart-final-bad-part" },
      body: new Uint8Array(5 * 1024 * 1024)
    }), { subject: "owner", origin: "https://nib.test" }));
    expect(badPart.error).toBe("Artifact part SHA-256 does not match expected full artifact segment");

    await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/parts/1`, {
      method: "PUT",
      headers: { "idempotency-key": "multipart-final-part-1" },
      body: bytes.slice(0, 5 * 1024 * 1024)
    }), { subject: "owner", origin: "https://nib.test" });
    const duplicate = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/parts/1`, {
      method: "PUT",
      headers: { "idempotency-key": "multipart-final-part-1" },
      body: bytes.slice(0, 5 * 1024 * 1024)
    }), { subject: "owner", origin: "https://nib.test" });
    expect(duplicate.headers.get("x-nib-idempotent-replay")).toBe("true");
    await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/parts/2`, {
      method: "PUT",
      headers: { "idempotency-key": "multipart-final-part-2" },
      body: bytes.slice(5 * 1024 * 1024)
    }), { subject: "owner", origin: "https://nib.test" });

    const finalized = await readJson(await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/finalize`, {
      method: "POST",
      headers: { "idempotency-key": "multipart-finalize" }
    }), { subject: "owner", origin: "https://nib.test" }));
    expect(finalized.artifact).toMatchObject({
      id: artifactId,
      status: "completed",
      uploadMode: "multipart",
      completedAt: expect.any(String)
    });
    expect([...media.values.keys()]).toContain((finalized.artifact as { objectKey: string }).objectKey);

    const replay = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/finalize`, {
      method: "POST",
      headers: { "idempotency-key": "multipart-finalize" }
    }), { subject: "owner", origin: "https://nib.test" });
    expect(replay.headers.get("x-nib-idempotent-replay")).toBe("true");
  });

  it("aborts multipart uploads and cleans staged parts", async () => {
    const media = new MemoryMediaStore();
    const core = new HostedRequestCoreService(new MemoryKeyValueStore(), media);
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    bytes.fill(3, 0, 5 * 1024 * 1024);
    bytes[bytes.length - 1] = 4;
    const created = await readJson(await core.createRequest({ title: "Abort multipart" }, { idempotencyKey: "abort-multipart-create" }));
    const request = created.request as { id: string };
    const initiated = await readJson(await core.initiateArtifact(request.id, {
      name: "abort.bin",
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      partSize: 5 * 1024 * 1024,
      parts: [
        { number: 1, sha256: await sha256Hex(bytes.slice(0, 5 * 1024 * 1024)) },
        { number: 2, sha256: await sha256Hex(bytes.slice(5 * 1024 * 1024)) }
      ]
    }, { idempotencyKey: "abort-multipart-init" }));
    const artifactId = (initiated.artifact as { id: string }).id;
    await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/parts/1`, {
      method: "PUT",
      headers: { "idempotency-key": "abort-multipart-part" },
      body: bytes.slice(0, 5 * 1024 * 1024)
    }), { subject: "owner", origin: "https://nib.test" });
    expect(media.multipart.size).toBe(1);

    const aborted = await readJson(await core.abortArtifact(request.id, artifactId, { idempotencyKey: "abort-multipart" }));
    expect(aborted.artifact).toMatchObject({ status: "aborted" });
    expect(media.multipart.size).toBe(0);
  });

  it("uses native R2 multipart create/upload/complete/abort without adapter assembly", async () => {
    const calls: string[] = [];
    const uploads = new Map<string, FakeMultipartUpload>();
    const bucket = {
      async put() { calls.push("put"); return { httpEtag: "single" }; },
      async get() { calls.push("get"); return null; },
      async delete() { calls.push("delete"); },
      async createMultipartUpload(key: string) {
        calls.push(`create:${key}`);
        const upload = new FakeMultipartUpload(key, "upload-native", calls);
        uploads.set(`${key}:upload-native`, upload);
        return upload;
      },
      resumeMultipartUpload(key: string, uploadId: string) {
        calls.push(`resume:${key}:${uploadId}`);
        const upload = uploads.get(`${key}:${uploadId}`);
        if (!upload) throw new Error("missing upload");
        return upload;
      }
    } as unknown as R2Bucket;
    const store = new R2MediaStore(bucket);
    const created = await store.createMultipart("artifact/native.bin");
    const uploaded = await store.uploadMultipartPart("artifact/native.bin", created.uploadId, 1, new Uint8Array([1, 2]));
    await store.completeMultipart("artifact/native.bin", created.uploadId, [uploaded]);
    const aborted = await store.createMultipart("artifact/abort.bin");
    await store.abortMultipart("artifact/abort.bin", aborted.uploadId);

    expect(calls).toEqual([
      "create:artifact/native.bin",
      "resume:artifact/native.bin:upload-native",
      "uploadPart:1",
      "resume:artifact/native.bin:upload-native",
      "complete:1:etag-1",
      "create:artifact/abort.bin",
      "resume:artifact/abort.bin:upload-native",
      "abort"
    ]);
    expect(calls).not.toContain("get");
    expect(calls).not.toContain("put");
  });

  it("serves replayable events over HTTP with SSE Last-Event-ID semantics", async () => {
    const core = createHostedRequestCoreForTest();

    await core.fetch(new Request("https://nib.test/v1/requests", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "http-create" },
      body: JSON.stringify({ title: "HTTP review" })
    }), { subject: "owner", origin: "https://nib.test" });

    const replay = await core.fetch(new Request("https://nib.test/v1/events", {
      headers: { accept: "text/event-stream", "last-event-id": "0" }
    }), { subject: "owner", origin: "https://nib.test" });

    expect(replay.headers.get("content-type")).toContain("text/event-stream");
    expect(await replay.text()).toContain("id: 1\nevent: request.created");
  });

  it("serves per-request events with after and SSE Last-Event-ID parity", async () => {
    const core = createHostedRequestCoreForTest();
    const first = await readJson(await core.createRequest({ title: "First" }, { idempotencyKey: "events-first" }));
    await core.createRequest({ title: "Second" }, { idempotencyKey: "events-second" });
    const request = first.request as { id: string };
    await core.createDecision(request.id, { outcome: "approved" }, { idempotencyKey: "events-decision", subject: "owner" });

    const jsonReplay = await readJson(await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/events?after=1`), {
      subject: "owner",
      origin: "https://nib.test"
    }));
    expect(jsonReplay.events).toEqual([
      expect.objectContaining({ type: "decision.created", requestId: request.id })
    ]);

    const sseReplay = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/events`, {
      headers: { accept: "text/event-stream", "last-event-id": "1" }
    }), { subject: "owner", origin: "https://nib.test" });
    expect(await sseReplay.text()).toContain("event: decision.created");
  });

  it("routes nested capability revoke and artifact completion mutations", async () => {
    const core = createHostedRequestCoreForTest();
    const created = await readJson(await core.fetch(new Request("https://nib.test/v1/requests", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "nested-create" },
      body: JSON.stringify({ title: "Nested routes" })
    }), { subject: "owner", origin: "https://nib.test" }));
    const request = created.request as { id: string };

    const capability = await readJson(await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "nested-cap" },
      body: JSON.stringify({ scopes: ["view"] })
    }), { subject: "owner", origin: "https://nib.test" }));
    const capabilityId = (capability.capability as { id: string }).id;

    const revoked = await readJson(await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/capabilities/${capabilityId}/revoke`, {
      method: "POST",
      headers: { "idempotency-key": "nested-cap-revoke" }
    }), { subject: "owner", origin: "https://nib.test" }));
    expect(revoked.capability).toMatchObject({ id: capabilityId, revokedAt: expect.any(String) });

    const initiated = await readJson(await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "nested-artifact" },
      body: JSON.stringify({ name: "asset.bin", contentType: "application/octet-stream", bytes: 2 })
    }), { subject: "owner", origin: "https://nib.test" }));
    const artifactId = (initiated.artifact as { id: string }).id;

    const completed = await readJson(await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/complete`, {
      method: "PUT",
      headers: { "idempotency-key": "nested-artifact-complete" },
      body: new Uint8Array([5, 6])
    }), { subject: "owner", origin: "https://nib.test" }));
    expect(completed.artifact).toMatchObject({ id: artifactId, status: "completed" });
  });

  it("serves hosted artifact content to capability guests with content and range headers", async () => {
    const core = createHostedRequestCoreForTest();
    const bytes = new Uint8Array([10, 11, 12, 13]);
    const created = await readJson(await core.createRequest({ title: "Artifact content" }, { idempotencyKey: "content-create" }));
    const request = created.request as { id: string };
    const capability = await readJson(await core.createCapability(request.id, { scopes: ["view"] }, { idempotencyKey: "content-cap" }));
    const initiated = await readJson(await core.initiateArtifact(request.id, {
      name: "clip.mp4",
      contentType: "video/mp4",
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes)
    }, { idempotencyKey: "content-init" }));
    const artifactId = (initiated.artifact as { id: string }).id;
    await core.completeArtifact(request.id, artifactId, bytes, { idempotencyKey: "content-complete" });

    const full = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/content`, {
      headers: { "x-nib-capability": capability.token as string }
    }), { subject: null, origin: "https://nib.test" });
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await full.arrayBuffer())]).toEqual([10, 11, 12, 13]);

    const range = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/content`, {
      headers: { "x-nib-capability": capability.token as string, range: "bytes=1-2" }
    }), { subject: null, origin: "https://nib.test" });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-2/4");
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([11, 12]);
  });

  it("mints opaque review-session cookies for media GETs and rejects revoked capabilities", async () => {
    const core = createHostedRequestCoreForTest();
    const bytes = new Uint8Array([10, 11, 12, 13]);
    const created = await readJson(await core.createRequest({ title: "Cookie content" }, { idempotencyKey: "cookie-create" }));
    const request = created.request as { id: string };
    const capability = await readJson(await core.createCapability(request.id, { scopes: ["view", "comment", "decide"] }, { idempotencyKey: "cookie-cap" }));
    const capabilityId = (capability.capability as { id: string }).id;

    const session = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/session`, {
      method: "POST",
      headers: { "x-nib-capability": capability.token as string }
    }), { subject: null, origin: "https://nib.test" });
    expect(session.status).toBe(204);
    const setCookie = session.headers.get("set-cookie") || "";
    expect(setCookie).toContain(`${REVIEW_SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain(`Path=/v1/requests/${request.id}`);
    const cookie = setCookie.split(";")[0];
    expect(cookie.split("=")[1]).not.toContain("nib_review_");

    const guest = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}`, {
      headers: { cookie }
    }), { subject: null, origin: "https://nib.test" });
    expect(guest.status).toBe(200);

    const feedback = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/feedback`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "idempotency-key": "cookie-feedback" },
      body: JSON.stringify({ kind: "comment", message: "Looks right" })
    }), { subject: null, origin: "https://nib.test" });
    expect(feedback.status).toBe(201);

    const initiated = await readJson(await core.initiateArtifact(request.id, {
      name: "clip.mp4",
      contentType: "video/mp4",
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes)
    }, { idempotencyKey: "cookie-init", subject: "owner" }));
    const artifactId = (initiated.artifact as { id: string }).id;
    await core.completeArtifact(request.id, artifactId, bytes, { idempotencyKey: "cookie-complete", subject: "owner" });

    const range = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/content`, {
      headers: { cookie, range: "bytes=1-2" }
    }), { subject: null, origin: "https://nib.test" });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-2/4");
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([11, 12]);

    await core.revokeCapability(request.id, capabilityId, { idempotencyKey: "cookie-revoke", subject: "owner" });
    const revoked = await core.fetch(new Request(`https://nib.test/v1/requests/${request.id}/artifacts/${artifactId}/content`, {
      headers: { cookie }
    }), { subject: null, origin: "https://nib.test" });
    expect(revoked.status).toBe(403);
  });

  it("renders zero-install review page with session exchange, artifact merge, comment action, and safe URLs", () => {
    const html = reviewPageHtml("req_123", "https://nib.test");

    expect(html).toContain("location.hash");
    expect(html).toContain("history.replaceState");
    expect(html).toContain('"/session"');
    expect(html).toContain('"x-nib-capability": token');
    expect(html).toContain('credentials: "same-origin"');
    expect(html).toContain('const apiPrefix = "/v1"');
    expect(html).toContain('apiPrefix + "/requests/" + encodeURIComponent(requestId)');
    expect(html).toContain('"/artifacts"');
    expect(html).toContain("mergeArtifacts");
    expect(html).toContain("safeArtifactUrl");
    expect(html).toContain('"/feedback"');
    expect(html).toContain('"/decisions"');
    expect(html).toContain('data-action="comment"');
    expect(html).toContain('"javascript:"');
    expect(html).toContain('"data:"');
    expect(html).toContain('"file:"');
    expect(html).not.toContain("?capability=");
    expect(html).not.toContain("innerHTML");
  });

  it("sets strict review page security headers", () => {
    const headers = reviewPageHeaders();

    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("base-uri 'none'");
  });

  it("routes trusted RPC tenants to isolated durable objects and ignores public tenant header spoofing", async () => {
    const env = fakeTenantEnv();

    const tenantA = stubForTenant(env, trustedTenantId("tenant-a"));
    const tenantB = stubForTenant(env, trustedTenantId("tenant-b"));
    await tenantA.fetch(new Request("https://nib.test/v1/requests", { method: "POST", body: "a" }));
    await tenantB.fetch(new Request("https://nib.test/v1/requests", { method: "POST", body: "b" }));

    expect(await (await tenantA.fetch(new Request("https://nib.test/v1/requests"))).text()).toBe("a");
    expect(await (await tenantB.fetch(new Request("https://nib.test/v1/requests"))).text()).toBe("b");
    expect(publicTenantId({ ...env, NIB_TENANT_ID: undefined }, new Request("https://nib.test/v1/requests", {
      headers: { "x-nib-tenant": "tenant-b" }
    }))).toBe("primary");
    expect(() => trustedTenantId("../tenant")).toThrow("Invalid tenant ID");
  });

  it("delivers terminal decision continuations once with injectable signing", async () => {
    const deliveries: ContinuationDelivery[] = [];
    const store = new MemoryKeyValueStore();
    const core = new HostedRequestCoreService(store, new MemoryMediaStore(), () => new Date("2026-08-09T17:00:00.000Z"), {
      async dispatch(delivery) {
        deliveries.push(delivery);
        return { ok: true, status: 202 };
      },
      async sign(delivery) {
        return `signed:${delivery.event.id}`;
      }
    });

    const created = await readJson(await core.createRequest({
      title: "Webhook decision",
      continuation: { type: "webhook", url: "https://hooks.test/nib", secret: "not-in-document" }
    }, { idempotencyKey: "webhook-create", subject: "owner" }));
    const request = created.request as { id: string };
    expect(JSON.stringify(created.request)).not.toContain("not-in-document");

    const first = await readJson(await core.createDecision(request.id, { outcome: "approved", terminal: true }, {
      idempotencyKey: "webhook-decision",
      subject: "owner"
    }));
    const replay = await readJson(await core.createDecision(request.id, { outcome: "approved", terminal: true }, {
      idempotencyKey: "webhook-decision",
      subject: "owner"
    }));

    expect(replay).toEqual(first);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      url: "https://hooks.test/nib",
      headers: {
        "content-type": "application/json",
        "x-nib-event-signature": `signed:${deliveries[0].event.id}`
      },
      event: {
        type: "decision.created",
        requestId: request.id,
        requestRevision: 1
      }
    });
  });

  it("redacts webhook configuration from guest reads and event payloads", async () => {
    const core = createHostedRequestCoreForTest();
    const rejected = await readJson(await core.createRequest({
      title: "Bad webhook",
      continuation: { type: "webhook", url: "http://hooks.test/insecure" }
    }, { idempotencyKey: "bad-webhook" }));
    expect(rejected.error).toBe("Webhook continuation URL must use HTTPS");

    const created = await readJson(await core.createRequest({
      title: "Guest redaction",
      continuation: { type: "webhook", url: "https://hooks.test/private" }
    }, { idempotencyKey: "guest-redaction" }));
    const request = created.request as { id: string };
    const capability = await readJson(await core.createCapability(request.id, {
      scopes: ["view"]
    }, { idempotencyKey: "guest-redaction-cap" }));
    const guest = await readJson(await core.getRequest(request.id, capability.token as string));
    const events = await core.listEvents({ after: "0", requestId: request.id });

    expect(JSON.stringify(guest)).not.toContain("https://hooks.test/private");
    expect(JSON.stringify(events)).not.toContain("https://hooks.test/private");
    expect(guest.request).toMatchObject({ continuation: { type: "webhook", configured: true } });
    expect(events.events[0].data.request).toMatchObject({ continuation: { type: "webhook", configured: true } });
  });
});

function assertCanonicalRequestShape(value: Record<string, unknown>): void {
  expect(value.formatVersion).toBe("1.0");
  expect(typeof value.revision).toBe("number");
  expect(value.revision as number).toBeGreaterThanOrEqual(1);
  expect(value.source).toEqual(expect.objectContaining({ type: expect.any(String) }));
  expect((value.source as { type: string }).type.length).toBeGreaterThan(0);
  expect(value.decision).toEqual(expect.objectContaining({ type: expect.any(String) }));
  expect(Array.isArray(value.artifacts)).toBe(true);
  expect(typeof value.createdAt).toBe("string");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fakeTenantEnv(): {
  REQUESTS: {
    idFromName(name: string): string;
    get(id: string): { fetch(request: Request): Promise<Response> };
  };
  NIB_TENANT_ID?: string;
} {
  const bodies = new Map<string, string>();
  return {
    REQUESTS: {
      idFromName(name: string) {
        return name;
      },
      get(id: string) {
        return {
          async fetch(request: Request): Promise<Response> {
            if (request.method === "POST") {
              bodies.set(id, await request.text());
              return new Response(null, { status: 201 });
            }
            return new Response(bodies.get(id) || "", { status: 200 });
          }
        };
      }
    }
  };
}

class FakeMultipartUpload {
  readonly parts: Array<{ partNumber: number; etag: string }> = [];

  constructor(
    readonly key: string,
    readonly uploadId: string,
    private readonly calls: string[]
  ) {}

  async uploadPart(partNumber: number): Promise<{ partNumber: number; etag: string }> {
    this.calls.push(`uploadPart:${partNumber}`);
    const part = { partNumber, etag: `etag-${partNumber}` };
    this.parts.push(part);
    return part;
  }

  async complete(parts: Array<{ partNumber: number; etag: string }>): Promise<{ httpEtag: string }> {
    this.calls.push(`complete:${parts.map((part) => `${part.partNumber}:${part.etag}`).join(",")}`);
    return { httpEtag: "complete-etag" };
  }

  async abort(): Promise<void> {
    this.calls.push("abort");
  }
}
