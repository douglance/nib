import assert from "node:assert/strict";
import { test } from "node:test";
import type { NibRequest } from "@nib/protocol";
import { buildRequest, createNibClient, parseWebhookContinuation, webhookContinuation } from "../src/index.ts";

test("request returns a handle with get, events, and wait", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/requests")) {
      const request = JSON.parse(String(init?.body)) as NibRequest;
      return json({ request, status: "pending" });
    }
    if (url.endsWith("/v1/requests/req_test")) {
      return json({
        request: buildRequest({ id: "req_test", title: "Approve", decision: { type: "approval" } }),
        status: calls.length < 3 ? "pending" : "approved",
      });
    }
    if (url.includes("/events?after=0")) {
      return json({
        events: [
          {
            id: "evt_1",
            type: "request.created",
            requestId: "req_test",
            requestRevision: 1,
            sequence: 1,
            timestamp: "2026-08-09T00:00:00Z",
          },
        ],
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const client = createNibClient({
    baseUrl: "https://nib.test/",
    token: "token",
    fetch,
    pollIntervalMs: 0,
    clock: () => new Date("2026-08-09T00:00:00Z"),
  });

  const handle = await client.request({
    id: "req_test",
    title: "Approve",
    decision: { type: "approval" },
    continuation: webhookContinuation("https://ci.test/nib"),
  });

  assert.equal(handle.id, "req_test");
  assert.equal(typeof handle.get, "function");
  assert.equal(typeof handle.events, "function");
  assert.equal(typeof handle.wait, "function");
  assert.equal(handle.reviewLink, undefined);
  assert.equal(calls[0].url, "https://nib.test/v1/requests");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer token");
  assert.match(new Headers(calls[0].init?.headers).get("idempotency-key") ?? "", /^idem_/);

  const [event] = await collect(handle.events({ once: true, pollIntervalMs: 0 }));
  assert.equal(event.type, "request.created");

  const snapshot = await handle.wait({ pollIntervalMs: 0, timeoutMs: 100 });
  assert.equal(snapshot.status, "approved");
});

test("request handle exposes hosted reviewLink from create response only", async () => {
  const client = createNibClient({
    baseUrl: "https://nib.test",
    fetch: async (input, init) => {
      const request = init?.body
        ? (JSON.parse(String(init.body)) as NibRequest)
        : buildRequest({ id: "req_link", title: "Approve", decision: { type: "approval" } });
      return json({
        request,
        status: "pending",
        reviewLink: String(input).endsWith("/v1/requests") ? "https://nibtool.com/review/capability" : "https://wrong",
      });
    },
  });

  const handle = await client.request({
    id: "req_link",
    title: "Approve",
    decision: { type: "approval" },
  });
  const snapshot = await handle.get();

  assert.equal(handle.reviewLink, "https://nibtool.com/review/capability");
  assert.equal("reviewLink" in snapshot, false);
});

test("request creation uses caller idempotency keys", async () => {
  const keys: string[] = [];
  const client = createNibClient({
    baseUrl: "https://nib.test",
    fetch: async (_input, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      const request = JSON.parse(String(init?.body)) as NibRequest;
      return json({ request, status: "pending" });
    },
  });

  await client.request({
    id: "req_keyed",
    idempotencyKey: "review-123",
    title: "Approve",
    decision: { type: "approval" },
  });

  assert.deepEqual(keys, ["review-123"]);
});

test("uploads artifacts through hosted initiate, upload, and finalize contract", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createNibClient({
    baseUrl: "https://nib.test",
    token: "token",
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/requests/req_1/artifacts")) {
        return json({
          artifactId: "art_1",
          uploadUrl: "https://uploads.nib.test/art_1",
          uploadHeaders: { "x-upload-token": "upload-token" },
          finalizeUrl: "https://nib.test/v1/requests/req_1/artifacts/art_1/finalize",
        });
      }
      if (url === "https://uploads.nib.test/art_1") {
        assert.equal(init?.method, "PUT");
        assert.equal(new Headers(init.headers).get("x-upload-token"), "upload-token");
        return json({});
      }
      if (url.endsWith("/v1/requests/req_1/artifacts/art_1/finalize")) {
        return json({
          artifact: {
            id: "art_1",
            type: "file",
            title: "trace.zip",
            source: {
              type: "external",
              url: "https://nibtool.com/artifacts/art_1",
              sha256: "abc",
              byteLength: 3,
            },
          },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const artifact = await client.uploadArtifact("req_1", {
    id: "trace",
    title: "trace.zip",
    type: "file",
    mimeType: "application/zip",
    bytes: new Uint8Array([1, 2, 3]),
    sha256: "abc",
    byteLength: 3,
    idempotencyKey: "artifact-key",
  });

  assert.equal(artifact.id, "art_1");
  assert.equal(calls[0].url, "https://nib.test/v1/requests/req_1/artifacts");
  assert.equal(new Headers(calls[0].init?.headers).get("idempotency-key"), "artifact-key");
  assert.equal(calls[2].url, "https://nib.test/v1/requests/req_1/artifacts/art_1/finalize");
});

test("generated idempotency keys stay stable across creation retry", async () => {
  const keys: string[] = [];
  const client = createNibClient({
    baseUrl: "https://nib.test",
    fetch: async (_input, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (keys.length === 1) {
        return new Response(JSON.stringify({ error: "retry" }), { status: 503 });
      }
      const request = JSON.parse(String(init?.body)) as NibRequest;
      return json({ request, status: "pending" });
    },
  });

  await client.request({
    id: "req_retry",
    title: "Approve",
    decision: { type: "approval" },
  });

  assert.equal(keys.length, 2);
  assert.match(keys[0], /^idem_/);
  assert.equal(keys[1], keys[0]);
});

test("default base URL is the canonical hosted origin", async () => {
  const urls: string[] = [];
  const client = createNibClient({
    fetch: async (input, init) => {
      urls.push(String(input));
      const request = JSON.parse(String(init?.body)) as NibRequest;
      return json({ request, status: "pending" });
    },
  });

  await client.request({
    id: "req_default_origin",
    title: "Approve",
    decision: { type: "approval" },
  });

  assert.equal(urls[0], "https://nibtool.com/v1/requests");
});

test("hosted snapshots preserve canonical status and events", async () => {
  const event = {
    id: "evt_approved",
    type: "request.approved",
    requestId: "req_status",
    requestRevision: 1,
    sequence: 2,
    timestamp: "2026-08-09T00:00:01Z",
  };
  const client = createNibClient({
    baseUrl: "https://nib.test",
    fetch: async () =>
      json({
        request: buildRequest({ id: "req_status", title: "Approve", decision: { type: "approval" } }),
        status: "changes_requested",
        decision: {
          id: "dec_1",
          requestId: "req_status",
          requestRevision: 1,
          outcome: "approved",
          reviewer: { id: "user_1", type: "user" },
          createdAt: "2026-08-09T00:00:01Z",
        },
        events: [event],
      }),
  });

  const snapshot = await client.get("req_status");

  assert.equal(snapshot.status, "changes_requested");
  assert.deepEqual(snapshot.events?.[0], event);
});

test("webhook continuation payloads validate the request boundary", () => {
  const payload = parseWebhookContinuation({ requestId: "req_1", status: "approved" });
  assert.equal(payload.requestId, "req_1");
  assert.throws(() => parseWebhookContinuation({ status: "approved" }), /Invalid Nib webhook/);
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
