import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";

test("preferred route update returns 404 instead of partial project for missing projects", async () => {
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "prtl-server-"));
  const server = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      CLIENT_PORT: String(port + 1),
      PRTL_DATA_DIR: dataDir,
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      LOCAL_BASE_URL: `http://127.0.0.1:${port}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

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
