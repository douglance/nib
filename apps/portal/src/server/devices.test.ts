import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("registerDevice stores APNs topic for native devices", async () => {
  process.env.NIB_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "nib-devices-"));
  const { registerDevice } = await import("./devices");

  const device = await registerDevice({
    name: "Apple Watch",
    platform: "watchos",
    pushKind: "apns",
    token: "watch-token",
    apnsTopic: "com.example.nib.watchkitapp",
    capabilities: ["alert", "actions"]
  });

  assert.equal(device.apnsTopic, "com.example.nib.watchkitapp");
});

test("registerDevice leaves web push APNs topic empty", async () => {
  process.env.NIB_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "nib-devices-"));
  const { registerDevice } = await import("./devices");

  const device = await registerDevice({
    name: "Browser",
    platform: "web",
    pushKind: "webpush",
    token: "https://push.example/device",
    apnsTopic: "com.example.nib",
    capabilities: ["alert"]
  });

  assert.equal(device.apnsTopic, null);
});
