import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestRecord } from "../shared/types";
import { requestPageHtml } from "./requestPage";

function makeRequest(overrides: Partial<RequestRecord> = {}): RequestRecord {
  const now = "2026-07-02T00:00:00.000Z";
  return {
    id: "req-1",
    kind: "choice",
    title: "smoke /r/:id",
    prompt: "pick one",
    body: null,
    context: "line1\nline2  <b>escaped?</b>",
    choices: ["Alpha", "Beta"],
    allowText: true,
    target: {},
    status: "open",
    priority: "normal",
    source: null,
    createdAt: now,
    updatedAt: now,
    viewedAt: null,
    answeredAt: null,
    actedAt: null,
    resolvedAt: null,
    expiresAt: null,
    notifiedAt: null,
    notificationClickedAt: null,
    staleReason: null,
    attachments: [],
    responses: [],
    metadata: {},
    ...overrides
  };
}

test("requestPageHtml renders title, prompt, choices, and escaped context", () => {
  const html = requestPageHtml(makeRequest());
  assert.ok(html.includes("smoke /r/:id"));
  assert.ok(html.includes("pick one"));
  assert.ok(html.includes('data-choice="Alpha"'));
  assert.ok(html.includes('data-choice="Beta"'));
  assert.ok(html.includes("line1\nline2  &lt;b&gt;escaped?&lt;/b&gt;"));
  assert.ok(!html.includes("<b>escaped?</b>"));
  assert.ok(html.includes("/api/requests/"));
});

test("requestPageHtml escapes markup in title, prompt, and choices", () => {
  const html = requestPageHtml(
    makeRequest({
      title: '<script>alert("t")</script>',
      prompt: "<img src=x onerror=1>",
      choices: ['"><svg onload=1>']
    })
  );
  assert.ok(!html.includes('<script>alert("t")</script>'));
  assert.ok(!html.includes("<img src=x onerror=1>"));
  assert.ok(html.includes('data-choice="&quot;&gt;&lt;svg onload=1&gt;"'));
});

test("requestPageHtml renders image attachments", () => {
  const html = requestPageHtml(
    makeRequest({
      attachments: [
        {
          id: "att-1",
          requestId: "req-1",
          name: "shot.png",
          type: "image",
          contentType: "image/png",
          bytes: 10,
          url: "/attachments/att-1",
          createdAt: "2026-07-02T00:00:00.000Z",
          metadata: {}
        }
      ]
    })
  );
  assert.ok(html.includes('<img src="/attachments/att-1"'));
});

test("requestPageHtml shows recorded response read-only when already answered", () => {
  const html = requestPageHtml(
    makeRequest({
      status: "answered",
      answeredAt: "2026-07-02T00:01:00.000Z",
      responses: [
        {
          id: "resp-1",
          kind: "choice",
          text: "Alpha",
          choice: "Alpha",
          createdAt: "2026-07-02T00:01:00.000Z"
        }
      ]
    })
  );
  assert.ok(html.toLowerCase().includes("answered"));
  assert.ok(html.includes("Alpha"));
  assert.ok(!html.includes("data-choice="));
  assert.ok(!html.includes("<form"));
});

test("requestPageHtml omits free-text form when allowText is false", () => {
  const html = requestPageHtml(makeRequest({ allowText: false }));
  assert.ok(!html.includes("<form"));
  assert.ok(html.includes('data-choice="Alpha"'));
});
