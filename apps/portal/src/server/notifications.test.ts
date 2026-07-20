import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RequestRecord } from "../shared/types";
import { apnsCategory, apnsJwt, apnsReadiness, apnsTopicForDevice, requestPayload } from "./notifications";

test("maps common first-two request choices to native APNs categories", () => {
  assert.equal(apnsCategory({ choices: ["Approve", "Hold"] }), "NIB_APPROVE_HOLD");
  assert.equal(apnsCategory({ choices: ["Approve", "Reject"] }), "NIB_APPROVE_REJECT");
  assert.equal(apnsCategory({ choices: ["Allow", "Deny"] }), "NIB_ALLOW_DENY");
  assert.equal(apnsCategory({ choices: ["Yes", "No"] }), "NIB_YES_NO");
  assert.equal(apnsCategory({ choices: ["Ship", "Hold"] }), "NIB_SHIP_HOLD");
  assert.equal(apnsCategory({ choices: ["Ship", "Hold", "Revise"] }), "NIB_SHIP_HOLD_REVISE");
  assert.equal(apnsCategory({ choices: ["Use it", "Revise"] }), "NIB_USE_REVISE");
});

test("falls back to generic choice, text, and open categories", () => {
  assert.equal(apnsCategory({ choices: ["Alpha", "Beta"] }), "NIB_CHOICE");
  assert.equal(apnsCategory({ allowText: true }), "NIB_TEXT");
  assert.equal(apnsCategory({}), "NIB_OPEN");
});

test("uses per-device APNs topics when available", () => {
  const config = { topic: "com.example.nib" };
  assert.equal(apnsTopicForDevice(config, { apnsTopic: "com.example.nib.watchkitapp" }), "com.example.nib.watchkitapp");
  assert.equal(apnsTopicForDevice(config, { apnsTopic: null }), "com.example.nib");
});

test("reports APNs readiness issues without requiring a send attempt", async () => {
  const keys = ["NIB_APNS_TEAM_ID", "NIB_APNS_KEY_ID", "NIB_APNS_KEY_PATH", "NIB_APNS_TOPIC", "NIB_APNS_ENV"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];

    const missing = await apnsReadiness();
    assert.equal(missing.apnsConfigured, false);
    assert.deepEqual(missing.apnsMissing, ["NIB_APNS_TEAM_ID", "NIB_APNS_KEY_ID", "NIB_APNS_KEY_PATH", "NIB_APNS_TOPIC"]);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nib-apns-"));
    const keyPath = path.join(dir, "AuthKey_TEST.p8");
    await fs.writeFile(keyPath, "test-key", "utf8");
    process.env.NIB_APNS_TEAM_ID = "TEAMID";
    process.env.NIB_APNS_KEY_ID = "KEYID";
    process.env.NIB_APNS_KEY_PATH = keyPath;
    process.env.NIB_APNS_TOPIC = "com.example.nib";
    process.env.NIB_APNS_ENV = "production";

    const ready = await apnsReadiness();
    assert.equal(ready.apnsConfigured, true);
    assert.equal(ready.apnsEnvironment, "production");
    assert.equal(ready.apnsTopic, "com.example.nib");
    assert.equal(ready.apnsKeyReadable, true);
    assert.deepEqual(ready.apnsIssues, []);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("creates APNs JWTs with a verifiable ES256 signature", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const token = apnsJwt({
    teamId: "TEAMID",
    keyId: "KEYID",
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  });
  const [header, claims, signature] = token.split(".");

  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), { alg: "ES256", kid: "KEYID" });
  assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString("utf8")).iss, "TEAMID");
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.equal(
    crypto.verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
    true
  );
});

test("visual-review notifications only open the web reviewer", () => {
  const now = new Date().toISOString();
  const request: RequestRecord = {
    id: "visual-review-1",
    kind: "visual-review",
    title: "Verify button alignment",
    prompt: "Verify button alignment",
    body: null,
    context: null,
    choices: ["Approve", "Reject"],
    allowText: true,
    target: {},
    status: "open",
    priority: "normal",
    source: "nib",
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
    metadata: { contract: "nib.visual-review/v1" }
  };

  const payload = requestPayload(request);

  assert.deepEqual(payload.choices, []);
  assert.equal(payload.allowText, false);
  assert.match(String(payload.url), /\/r\//);
});
