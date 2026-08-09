import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { NibRequest } from "@nib/protocol";
import {
  type CallbackNormalization,
  createEmailAdapter,
  createHmacVerifier,
  createPushAdapter,
  createSlackAdapter,
  createSmsAdapter,
  createTeamsAdapter,
  renderReviewText,
  verifyCallbackSignature,
} from "../src/index.ts";

const request: NibRequest = {
  id: "req_123",
  formatVersion: "1.0",
  revision: 2,
  title: "Review checkout copy",
  description: "Confirm the empty state copy is acceptable.",
  source: { type: "test", system: "node:test" },
  artifacts: [],
  decision: {
    type: "approval",
    options: [
      { id: "approved", label: "Approve" },
      { id: "changes_requested", label: "Request changes" },
      { id: "rejected", label: "Reject" },
    ],
  },
  createdAt: "2026-08-09T00:00:00Z",
};

test("renders an accessibility-safe plain text fallback with the review link", () => {
  assert.equal(
    renderReviewText({ request, reviewUrl: "https://nib.test/r/req_123" }),
    [
      "Nib Request: Review checkout copy",
      "Confirm the empty state copy is acceptable.",
      "Open review: https://nib.test/r/req_123",
      "Decision requested: approval",
    ].join("\n"),
  );
});

test("Slack adapter sends Block Kit and normalizes signed button callbacks", async () => {
  const deliveries: unknown[] = [];
  const adapter = createSlackAdapter({
    signingSecret: "secret",
    transport: async (message) => {
      deliveries.push(message);
      return { providerMessageId: "slack_1" };
    },
  });

  const receipt = await adapter.send({
    destination: { type: "channel", id: "C123" },
    notification: { request, reviewUrl: "https://nib.test/r/req_123" },
  });

  assert.equal(receipt.provider, "slack");
  assert.equal(receipt.providerMessageId, "slack_1");
  assert.equal(JSON.stringify(deliveries[0]).includes("https://nib.test/r/req_123"), true);
  assert.equal(JSON.stringify(deliveries[0]).includes("fallback"), false);

  const rawBody = JSON.stringify({
    user: { id: "U1", username: "ada", name: "Ada" },
    actions: [{ action_id: "nib_decision", value: "changes_requested" }],
    message: { ts: "123.456" },
  });
  const timestamp = "1786290000";
  const signature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const callback = await adapter.normalizeCallback({
    rawBody,
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body: JSON.parse(rawBody),
    request,
  });

  const decision = expectDecision(callback);
  assert.equal(decision.outcome, "changes_requested");
  assert.equal(decision.reviewer.id, "U1");
  assert.equal(decision.requestRevision, 2);
});

test("Teams adapter sends an Adaptive Card and maps submit callbacks", async () => {
  const deliveries: unknown[] = [];
  const adapter = createTeamsAdapter({
    transport: async (message) => {
      deliveries.push(message);
      return { providerMessageId: "teams_1" };
    },
  });

  await adapter.send({
    destination: { type: "conversation", id: "19:abc" },
    notification: { request, reviewUrl: "https://nib.test/r/req_123" },
  });

  assert.equal(JSON.stringify(deliveries[0]).includes("AdaptiveCard"), true);
  assert.equal(JSON.stringify(deliveries[0]).includes("https://nib.test/r/req_123"), true);

  const callback = await adapter.normalizeCallback({
    body: {
      from: { aadObjectId: "aad-1", name: "Grace" },
      value: { outcome: "approved", comment: "Looks right" },
      replyToId: "teams_1",
    },
    request,
  });

  const decision = expectDecision(callback);
  assert.equal(decision.outcome, "approved");
  assert.equal(decision.feedback?.[0]?.type, "comment");
});

test("email adapter sends text/html fallbacks and maps signed form submissions", async () => {
  const deliveries: unknown[] = [];
  const adapter = createEmailAdapter({
    from: "nib@example.com",
    verifier: createHmacVerifier({ secret: "email-secret", header: "x-nib-signature" }),
    transport: async (message) => {
      deliveries.push(message);
      return { providerMessageId: "email_1" };
    },
  });

  await adapter.send({
    destination: { type: "email", id: "reviewer@example.com" },
    notification: { request, reviewUrl: "https://nib.test/r/req_123" },
  });

  const message = deliveries[0] as { text: string; html: string; subject: string };
  assert.equal(message.subject, "Nib Request: Review checkout copy");
  assert.match(message.text, /Open review: https:\/\/nib\.test\/r\/req_123/);
  assert.match(message.html, /href="https:\/\/nib\.test\/r\/req_123"/);

  const rawBody = JSON.stringify({ outcome: "rejected", comment: "Missing legal copy", from: "reviewer@example.com" });
  const signature = createHmac("sha256", "email-secret").update(rawBody).digest("hex");
  const callback = await adapter.normalizeCallback({
    rawBody,
    headers: { "x-nib-signature": signature },
    body: JSON.parse(rawBody),
    request,
  });

  const decision = expectDecision(callback);
  assert.equal(decision.outcome, "rejected");
  assert.equal(decision.feedback?.[0]?.text, "Missing legal copy");
});

test("SMS adapter keeps delivery short and treats keyword replies as decisions", async () => {
  const deliveries: unknown[] = [];
  const adapter = createSmsAdapter({
    transport: async (message) => {
      deliveries.push(message);
      return { providerMessageId: "sms_1" };
    },
  });

  await adapter.send({
    destination: { type: "phone", id: "+15551234567" },
    notification: { request, reviewUrl: "https://nib.test/r/req_123" },
  });

  const message = deliveries[0] as { text: string };
  assert.equal(message.text.includes("\n"), false);
  assert.match(message.text, /https:\/\/nib\.test\/r\/req_123/);

  const callback = await adapter.normalizeCallback({
    body: { from: "+15551234567", text: "changes please adjust contrast" },
    request,
  });

  const decision = expectDecision(callback);
  assert.equal(decision.outcome, "changes_requested");
  assert.equal(decision.feedback?.[0]?.text, "please adjust contrast");
});

test("push adapter sends deep-link data and normalizes app actions", async () => {
  const deliveries: unknown[] = [];
  const adapter = createPushAdapter({
    transport: async (message) => {
      deliveries.push(message);
      return { providerMessageId: "push_1" };
    },
  });

  await adapter.send({
    destination: { type: "device", id: "device-token" },
    notification: { request, reviewUrl: "https://nib.test/r/req_123" },
  });

  assert.deepEqual(deliveries[0], {
    token: "device-token",
    title: "Review checkout copy",
    body: "Confirm the empty state copy is acceptable.",
    data: {
      requestId: "req_123",
      requestRevision: "2",
      reviewUrl: "https://nib.test/r/req_123",
    },
  });

  const callback = await adapter.normalizeCallback({
    body: { reviewerId: "user-1", reviewerName: "Lin", outcome: "approved" },
    request,
  });

  const decision = expectDecision(callback);
  assert.equal(decision.reviewer.type, "push_user");
});

function expectDecision(callback: CallbackNormalization) {
  if (callback.kind !== "decision") {
    throw new Error(`Expected decision callback, got ${callback.kind}`);
  }
  return callback.decision;
}

test("generic signature hook rejects invalid callbacks before normalization", async () => {
  const verifier = createHmacVerifier({ secret: "secret", header: "x-nib-signature" });
  await assert.rejects(
    verifyCallbackSignature({ verifier, rawBody: "payload", headers: { "x-nib-signature": "bad" } }),
    /Invalid callback signature/,
  );
});
