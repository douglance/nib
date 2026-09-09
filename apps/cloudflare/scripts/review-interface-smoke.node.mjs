import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReviewPage,
  healthPath,
  inspectControls,
  nativeRequestId,
  normalizedBase,
  reviewExpectation,
  summarizeProbe,
  tabulate
} from "./review-interface-smoke.mjs";

const currentPage = `
  <main>
    <form id="response-form">
      <button data-decision="approve">Approve</button>
      <button data-decision="reject">Reject</button>
      <button data-decision="comment">Send comment</button>
    </form>
    <p aria-live="polite"></p>
  </main>`;

test("classifies the current response interface and legacy launcher", () => {
  assert.equal(classifyReviewPage(currentPage), "response-interface");
  assert.equal(
    classifyReviewPage("<h1>Open this review in Nib</h1><a>Open Nib</a>"),
    "legacy-launcher"
  );
  assert.equal(classifyReviewPage("<h1>Unknown</h1>"), "unknown");
});

test("finds every response control and live status region", () => {
  assert.deepEqual(inspectControls(currentPage), {
    approve: true,
    reject: true,
    comment: true,
    liveStatus: true
  });
});

test("reads the native handoff request identity from either interface", () => {
  assert.equal(nativeRequestId(currentPage), null);
  assert.equal(
    nativeRequestId('<a href="nib://request/22222222-2222-4222-8222-222222222222">Open Nib</a>'),
    "22222222-2222-4222-8222-222222222222"
  );
});

test("uses a route-only production expectation without a production review URL", () => {
  assert.deepEqual(reviewExpectation(false), {
    dataStatuses: [404],
    attachmentRequired: false
  });
  assert.deepEqual(reviewExpectation(true), {
    dataStatuses: [200],
    attachmentRequired: true
  });
});

test("uses each deployed surface's actual health endpoint", () => {
  assert.equal(healthPath("local"), "/api/health");
  assert.equal(healthPath("production"), "/health");
});

test("normalizes origin-only bases without creating double-slash API paths", () => {
  assert.equal(normalizedBase("http://127.0.0.1:8791/", true), "http://127.0.0.1:8791");
  assert.equal(normalizedBase("https://nibtool.com/", false), "https://nibtool.com");
});

test("renders a compact local-versus-production matrix", () => {
  assert.equal(
    tabulate([
      ["page", "200 response-interface", "200 response-interface"],
      ["data", "200 application/json", "200 text/html"]
    ]),
    [
      "INTERFACE  LOCAL                   PRODUCTION",
      "page       200 response-interface  200 response-interface",
      "data       200 application/json    200 text/html"
    ].join("\n")
  );
});

test("machine-readable probe summaries omit response bodies and attachment tokens", () => {
  const summary = summarizeProbe({
    name: "production",
    base: "https://nibtool.com",
    reviewUrl: "https://nibtool.com/r/account/request",
    health: { status: 200, contentType: "application/json", text: "secret", json: {}, error: null },
    page: {
      status: 200,
      contentType: "text/html",
      text: "secret",
      json: null,
      error: null,
      classification: "response-interface",
      controls: { approve: true, reject: true, comment: true, liveStatus: true }
    },
    data: {
      status: 200,
      contentType: "application/json",
      text: "secret",
      json: { id: "request", attachment: { url: "/attachment?access=secret-token" } },
      error: null
    },
    attachment: { status: 200, contentType: "image/png", text: "secret", json: null, error: null }
  });

  assert.deepEqual(summary.data, {
    status: 200,
    contentType: "application/json",
    error: null,
    hasReview: true,
    hasAttachment: true
  });
  assert.equal(JSON.stringify(summary).includes("secret-token"), false);
  assert.equal(JSON.stringify(summary).includes('"text"'), false);
});
