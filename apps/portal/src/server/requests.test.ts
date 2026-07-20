import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CodeStateSnapshot, FeedbackRequest } from "../shared/types";

test("createRequest resolves project targets to canonical viewer URLs", async () => {
  process.env.NIB_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "nib-requests-"));
  const { createRequest } = await import("./requests");

  const request = await createRequest({
    prompt: "Can I ship this?",
    choices: ["Ship", "Hold"],
    projectId: "local app",
    appPath: "review/item",
    notify: false
  });

  assert.equal(request.target.projectId, "local app");
  assert.equal(request.target.appPath, "/review/item");
  assert.equal(request.target.url, "/view/local%20app?path=%2Freview%2Fitem");
});

test("respondRequest records direct notification actions as notification interactions", async () => {
  const { createRequest, respondRequest } = await import("./requests");
  const request = await createRequest({
    prompt: "Ship it?",
    choices: ["Ship", "Hold"],
    notify: false
  });

  const answered = await respondRequest(request.id, { choiceIndex: 0, deviceId: "ios-notification" });

  assert.equal(answered?.status, "answered");
  assert.equal(answered?.responses[0]?.choice, "Ship");
  assert.equal(answered?.responses[0]?.deviceId, "ios-notification");
  assert.ok(answered?.notificationClickedAt);
  assert.ok(answered?.viewedAt);
});

test("respondRequest keeps normal in-app answers separate from notification interactions", async () => {
  const { createRequest, respondRequest } = await import("./requests");
  const request = await createRequest({
    prompt: "Any notes?",
    notify: false
  });

  const answered = await respondRequest(request.id, { text: "Looks good" });

  assert.equal(answered?.status, "answered");
  assert.equal(answered?.responses[0]?.text, "Looks good");
  assert.equal(answered?.notificationClickedAt, null);
  assert.equal(answered?.viewedAt, null);
});

test("feedbackToRequest preserves a canonical viewer URL for legacy feedback", async () => {
  const { feedbackToRequest } = await import("./requests");
  const state = codeState();
  const feedback: FeedbackRequest = {
    id: "feedback-1",
    projectId: "registered app",
    resolvedProjectId: null,
    projectName: "Registered App",
    canonicalProjectKey: "registered app",
    projectAliases: ["Registered App"],
    projectAvailable: true,
    appPath: "/checkout",
    prompt: "Does this look right?",
    context: null,
    responseMode: "freeform",
    responseSpec: null,
    metadata: {},
    feedbackSurface: null,
    choices: [],
    artifacts: [],
    status: "open",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    viewedAt: null,
    answeredAt: null,
    resolvedAt: null,
    notifiedAt: null,
    notificationClickedAt: null,
    firstInteractionAt: null,
    requestedState: state,
    currentState: state,
    answeredState: null,
    isStale: false,
    staleReason: null,
    edits: [],
    responses: [],
    metrics: {
      notifiedAt: null,
      notificationClickedAt: null,
      firstInteractionAt: null,
      answeredAt: null,
      requestToNotifyMs: null,
      notifyToOpenMs: null,
      openToAnswerMs: null,
      requestToAnswerMs: null
    }
  };

  assert.equal(
    feedbackToRequest(feedback).target.url,
    "/view/registered%20app?path=%2Fcheckout&feedback=feedback-1"
  );
});

test("visual reviews stay hidden until preview and canonical Nib attachments are published", async () => {
  const { addRequestAttachment, createRequest, listRequests, publishRequest } = await import("./requests");
  const request = await createRequest({
    kind: "visual-review",
    title: "Verify button alignment",
    prompt: "Verify button alignment",
    metadata: { contract: "nib.visual-review/v1" },
    notify: false
  });

  assert.equal((await listRequests()).some((item) => item.id === request.id), false);
  await assert.rejects(() => publishRequest(request.id), /preview image attachment/i);

  await addRequestAttachment(request.id, {
    name: "review.png",
    contentType: "image/png",
    contentBase64: Buffer.from("png").toString("base64"),
    metadata: { role: "preview" }
  });
  await assert.rejects(() => publishRequest(request.id), /canonical \.nib attachment/i);

  await addRequestAttachment(request.id, {
    name: "review.nib",
    contentType: "application/x-nib",
    contentBase64: Buffer.from("nib").toString("base64"),
    metadata: { role: "canonical" }
  });
  const published = await publishRequest(request.id);

  assert.ok(published?.publishedAt);
  assert.equal((await listRequests()).some((item) => item.id === request.id), true);
  await assert.rejects(
    () => addRequestAttachment(request.id, {
      name: "late.png",
      contentType: "image/png",
      contentBase64: Buffer.from("late").toString("base64")
    }),
    /already published/i
  );
});

test("visual reviews accept exactly one structured response", async () => {
  const { respondRequest } = await import("./requests");
  const request = await createPublishedVisualReview();
  const annotations = [{ id: "a1", type: "rectangle", x: 10, y: 20, width: 30, height: 40 }];

  const answered = await respondRequest(request.id, {
    decision: "reject",
    comment: "Move this button left.",
    annotations
  });

  assert.equal(answered?.status, "answered");
  assert.equal(answered?.responses.length, 1);
  assert.equal(answered?.responses[0]?.kind, "visual-review");
  assert.equal(answered?.responses[0]?.choice, "reject");
  assert.equal(answered?.responses[0]?.text, "Move this button left.");
  assert.deepEqual(answered?.responses[0]?.data, {
    contract: "nib.visual-review/v1",
    decision: "reject",
    comment: "Move this button left.",
    annotations
  });

  await assert.rejects(
    () => respondRequest(request.id, { decision: "approve", annotations: [] }),
    /already has a response/i
  );
});

test("simultaneous visual review responses have exactly one winner", async () => {
  const { getRequest, respondRequest } = await import("./requests");
  const request = await createPublishedVisualReview();

  const results = await Promise.allSettled([
    respondRequest(request.id, { decision: "approve", annotations: [] }),
    respondRequest(request.id, { decision: "reject", comment: "Not yet.", annotations: [] })
  ]);
  const stored = await getRequest(request.id);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(stored?.responses.length, 1);
});

async function createPublishedVisualReview() {
  const { addRequestAttachment, createRequest, publishRequest } = await import("./requests");
  const request = await createRequest({
    kind: "visual-review",
    prompt: "Review this image",
    metadata: { contract: "nib.visual-review/v1" },
    notify: false
  });
  await addRequestAttachment(request.id, {
    name: "review.png",
    contentType: "image/png",
    contentBase64: Buffer.from("png").toString("base64"),
    metadata: { role: "preview" }
  });
  await addRequestAttachment(request.id, {
    name: "review.nib",
    contentType: "application/x-nib",
    contentBase64: Buffer.from("nib").toString("base64"),
    metadata: { role: "canonical" }
  });
  return (await publishRequest(request.id)) ?? request;
}

function codeState(): CodeStateSnapshot {
  return {
    id: "state-1",
    capturedAt: "2026-06-06T00:00:00.000Z",
    runtime: {
      projectId: "registered app",
      projectName: "Registered App",
      sourcePath: null,
      routeMode: "pathProxy",
      routeUrl: "/view/registered%20app?path=%2Fcheckout",
      appPath: "/checkout",
      port: 4070,
      processCommand: null,
      portalVersion: "test"
    },
    git: null,
    fingerprint: "fingerprint"
  };
}
