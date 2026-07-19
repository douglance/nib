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
