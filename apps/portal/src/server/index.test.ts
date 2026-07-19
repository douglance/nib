import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import type { RequestRecord } from "../shared/types";

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
