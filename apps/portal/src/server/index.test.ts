import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { RequestRecord } from "../shared/types";

test("serves the Nib universal-link association and redirects iOS review links into the app", async () => {
  const { port, server } = await startTestServer();

  try {
    const associationResponse = await fetch(`http://127.0.0.1:${port}/.well-known/apple-app-site-association`);
    assert.equal(associationResponse.status, 200);
    assert.equal(associationResponse.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await associationResponse.json(), {
      applinks: {
        apps: [],
        details: [{
          appID: "2AS3V73632.com.douglance.nib",
          paths: ["/r/*"]
        }]
      }
    });

    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "visual-review",
        title: "Open this image in Nib",
        prompt: "Open this image in Nib",
        source: "test",
        metadata: { contract: "nib.visual-review/v1" },
        notify: false
      })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as RequestRecord;

    const reviewResponse = await fetch(`http://127.0.0.1:${port}/r/${created.id}`, {
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)" },
      redirect: "manual"
    });
    assert.equal(reviewResponse.status, 302);
    const location = new URL(reviewResponse.headers.get("location") ?? "");
    assert.equal(location.protocol, "nib:");
    assert.equal(location.host, "request");
    assert.equal(location.pathname, `/${created.id}`);
    assert.equal(location.searchParams.get("server"), `http://127.0.0.1:${port}`);
  } finally {
    server.kill();
    await once(server, "exit").catch(() => undefined);
  }
});

test("preferred route update returns 404 instead of partial project for missing projects", async () => {
  const { port, server } = await startTestServer();

  try {
    await waitForServer(port, server);
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/missing-project/preferred-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "pathProxy" })
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Project not found" });
  } finally {
    server.kill();
    await once(server, "exit").catch(() => undefined);
  }
});

test("visual review API publishes atomically, streams updates, and accepts one response", async () => {
  const { port, server } = await startTestServer();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "visual-review",
        title: "Verify button alignment",
        prompt: "Verify button alignment",
        source: "mac-pro / tmux:session-1",
        metadata: { contract: "nib.visual-review/v1" },
        notify: false
      })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as RequestRecord;
    const draftsHidden = await fetch(`http://127.0.0.1:${port}/api/requests`).then((response) => response.json()) as RequestRecord[];
    assert.equal(draftsHidden.some((request) => request.id === created.id), false);

    await uploadAttachment(port, created.id, "review.png", "image/png", "preview");
    await uploadAttachment(port, created.id, "review.nib", "application/x-nib", "canonical");

    const events = await fetch(`http://127.0.0.1:${port}/api/requests/events`);
    assert.equal(events.status, 200);
    assert.ok(events.body);
    reader = events.body.getReader();

    const publishedResponse = await fetch(`http://127.0.0.1:${port}/api/requests/${created.id}/publish`, { method: "POST" });
    assert.equal(publishedResponse.status, 200);
    const published = await publishedResponse.json() as RequestRecord;
    assert.ok(published.publishedAt);
    assert.match(await readSseUntil(reader, created.id), /event: request/);

    const answeredResponse = await fetch(`http://127.0.0.1:${port}/api/requests/${created.id}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", comment: "Looks good.", annotations: [] })
    });
    assert.equal(answeredResponse.status, 200);
    const answered = await answeredResponse.json() as RequestRecord;
    assert.equal(answered.responses[0]?.data?.decision, "approve");

    const duplicate = await fetch(`http://127.0.0.1:${port}/api/requests/${created.id}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", annotations: [] })
    });
    assert.equal(duplicate.status, 409);
    assert.match(String((await duplicate.json() as { error: string }).error), /already has a response/i);
  } finally {
    await reader?.cancel().catch(() => undefined);
    server.kill();
    await once(server, "exit").catch(() => undefined);
  }
});

test("streams MP4 uploads and serves seekable byte ranges with the stored content type", async () => {
  const { port, server } = await startTestServer();
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "visual-review",
        prompt: "Review this video",
        metadata: { contract: "nib.review/v2" },
        notify: false
      })
    }).then((response) => response.json()) as RequestRecord;
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftyp"),
      Buffer.from("isom0000avc1")
    ]);
    const upload = await fetch(`http://127.0.0.1:${port}/api/requests/${created.id}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "video/mp4",
        "x-nib-filename": "review.mp4",
        "x-nib-metadata": JSON.stringify({ role: "primary" })
      },
      body: mp4
    });
    assert.equal(upload.status, 201);
    const attachment = await upload.json() as RequestRecord["attachments"][number];
    const patched = await fetch(`http://127.0.0.1:${port}/api/requests/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metadata: {
          subject: {
            contract: "nib.review/v2",
            primary: {
              attachmentId: attachment.id,
              kind: "video",
              contentType: "video/mp4",
              width: 1280,
              height: 720,
              durationMs: 2_000,
              sha256: "test"
            }
          }
        }
      })
    });
    assert.equal(patched.status, 200);
    const publish = await fetch(`http://127.0.0.1:${port}/api/requests/${created.id}/publish`, { method: "POST" });
    assert.equal(publish.status, 200);

    const range = await fetch(`http://127.0.0.1:${port}${attachment.url}`, {
      headers: { range: "bytes=4-7" }
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-type"), "video/mp4");
    assert.equal(range.headers.get("content-range"), `bytes 4-7/${mp4.length}`);
    assert.equal(Buffer.from(await range.arrayBuffer()).toString("ascii"), "ftyp");
  } finally {
    server.kill();
    await once(server, "exit").catch(() => undefined);
  }
});

test("request WebSocket pushes published updates immediately", async () => {
  const { port, server } = await startTestServer();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/requests/socket`);

  try {
    const readyMessage = nextSocketMessage(socket, (message) => message.type === "ready");
    await once(socket, "open");
    await readyMessage;

    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "visual-review",
        title: "Push this review over WebSocket",
        prompt: "Push this review over WebSocket",
        source: "test",
        metadata: { contract: "nib.visual-review/v1" },
        notify: false
      })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as RequestRecord;
    await uploadAttachment(port, created.id, "review.png", "image/png", "preview");
    await uploadAttachment(port, created.id, "review.nib", "application/x-nib", "canonical");

    const publishedMessage = nextSocketMessage(
      socket,
      (message) => message.type === "request" && message.action === "published" && message.request?.id === created.id
    );
    const publishedResponse = await fetch(`http://127.0.0.1:${port}/api/requests/${created.id}/publish`, {
      method: "POST"
    });
    assert.equal(publishedResponse.status, 200);

    const event = await publishedMessage;
    assert.equal(event.request?.status, "open");
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      const closed = once(socket, "close").catch(() => undefined);
      socket.close(1000, "test complete");
      await closed;
    }
    server.kill();
    await once(server, "exit").catch(() => undefined);
  }
});

async function startTestServer(): Promise<{ port: number; server: ChildProcess }> {
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nib-server-"));
  const server = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      CLIENT_PORT: String(port + 1),
      NIB_DATA_DIR: dataDir,
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      LOCAL_BASE_URL: `http://127.0.0.1:${port}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer(port, server);
  return { port, server };
}

async function uploadAttachment(port: number, requestId: string, name: string, contentType: string, role: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/requests/${requestId}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      contentType,
      contentBase64: Buffer.from(name).toString("base64"),
      metadata: { role }
    })
  });
  assert.equal(response.status, 201);
}

async function readSseUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE event timed out")), 1000))
    ]);
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
    if (output.includes(needle) && output.includes("event: request")) return output;
  }
  throw new Error(`SSE stream did not include ${needle}: ${output}`);
}

interface RequestSocketMessage {
  type: "ready" | "request";
  action?: "created" | "published" | "updated" | "responded";
  request?: RequestRecord;
}

function nextSocketMessage(
  socket: WebSocket,
  predicate: (message: RequestSocketMessage) => boolean
): Promise<RequestSocketMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("WebSocket event timed out"));
    }, 2_000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as RequestSocketMessage;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

async function waitForServer(port: number, server: ChildProcess): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`server exited with ${server.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError instanceof Error ? lastError : new Error("server did not start");
}

async function freePort(): Promise<number> {
  const net = await import("node:net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("failed to allocate port");
  return address.port;
}
