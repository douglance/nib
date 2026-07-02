import crypto from "node:crypto";
import fs from "node:fs/promises";
import http2 from "node:http2";
import path from "node:path";
import webpush from "web-push";
import type { DeviceRecord, FeedbackRequest, NotificationSubscriptionRecord, RequestRecord } from "../shared/types";
import { DATA_DIR, PUBLIC_BASE_URL } from "./config";
import { readStore, writeStore } from "./store";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface SubscribeInput {
  subscription?: PushSubscriptionJSON;
  userAgent?: string | null;
}

const pushPath = path.join(DATA_DIR, "push.json");

export async function getVapidPublicKey(): Promise<string> {
  return (await ensureVapidKeys()).publicKey;
}

export async function notificationStatus() {
  const store = await readStore();
  const devices = Object.values(store.devices ?? {});
  const apnsDevices = devices.filter((device) => device.pushKind === "apns");
  const apnsHealthyDeviceCount = apnsDevices.filter((device) => !device.lastError).length;
  const apnsLastError = apnsDevices.find((device) => device.lastError)?.lastError ?? null;
  const apns = await apnsReadiness();
  return {
    vapidPublicKey: await getVapidPublicKey(),
    subscriptionCount: Object.keys(store.notificationSubscriptions).length,
    deviceCount: devices.length,
    webPushDeviceCount: devices.filter((device) => device.pushKind === "webpush").length,
    apnsDeviceCount: apnsDevices.length,
    apnsHealthyDeviceCount,
    apnsLastError,
    webReady: Object.keys(store.notificationSubscriptions).length > 0,
    nativeReady: apns.apnsConfigured && apnsHealthyDeviceCount > 0,
    ...apns
  };
}

export async function subscribeNotifications(input: SubscribeInput): Promise<NotificationSubscriptionRecord> {
  if (!input.subscription?.endpoint) throw new Error("subscription.endpoint is required");
  const store = await readStore();
  const now = new Date().toISOString();
  const id = subscriptionId(input.subscription.endpoint);
  const existing = store.notificationSubscriptions[id];
  const record: NotificationSubscriptionRecord = {
    id,
    endpoint: input.subscription.endpoint,
    subscription: input.subscription,
    userAgent: input.userAgent ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastError: null
  };
  store.notificationSubscriptions[id] = record;
  store.devices[id] = {
    id,
    name: "Web Push",
    platform: "web",
    pushKind: "webpush",
    token: input.subscription.endpoint,
    apnsTopic: null,
    userAgent: input.userAgent ?? null,
    capabilities: ["alert", "open"],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastError: null
  };
  await writeStore(store);
  return record;
}

export async function unsubscribeNotifications(endpoint: string): Promise<{ removed: boolean }> {
  const store = await readStore();
  const id = subscriptionId(endpoint);
  const removed = Boolean(store.notificationSubscriptions[id]);
  delete store.notificationSubscriptions[id];
  delete store.devices[id];
  await writeStore(store);
  return { removed };
}

export async function sendFeedbackNotification(request: FeedbackRequest): Promise<FeedbackRequest> {
  if (!request.projectAvailable || !request.resolvedProjectId) return request;
  const sent = await sendPushPayload(feedbackPayload(request));
  if (sent === 0) return request;
  return (await markNotificationSent(request.id)) ?? request;
}

export async function sendTestNotification(): Promise<{ sent: number; requestId?: string; feedbackId?: string; type: string }> {
  const latestRequest = await latestActiveRequest();
  if (latestRequest) {
    const sent = await sendUnifiedPayload(requestPayload(latestRequest));
    if (sent > 0) await markRequestNotificationSent(latestRequest.id);
    return { sent, requestId: latestRequest.id, type: "request" };
  }
  const latestFeedback = await latestActiveFeedback();
  if (latestFeedback) {
    const sent = await sendUnifiedPayload(feedbackPayload(latestFeedback));
    if (sent > 0) await markNotificationSent(latestFeedback.id);
    return { sent, feedbackId: latestFeedback.id, type: "feedback" };
  }
  const sent = await sendUnifiedPayload({
    type: "test",
    title: "prtl",
    body: "No active requests. Tap to open prtl.",
    url: "/",
    createdAt: new Date().toISOString()
  });
  return { sent, type: "test" };
}

export async function sendNotice(input: {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  kind?: string;
}): Promise<{ sent: number }> {
  return {
    sent: await sendUnifiedPayload({
      type: input.kind ?? "notice",
      title: input.title,
      body: input.body,
      url: input.url ?? "/",
      tag: input.tag,
      requireInteraction: true,
      renotify: true,
      createdAt: new Date().toISOString()
    })
  };
}

export async function probeApnsDelivery(): Promise<{
  configured: boolean;
  environment: "sandbox" | "production";
  topic: string | null;
  deviceCount: number;
  sent: number;
  devices: Array<{
    id: string;
    name: string;
    platform: string;
    apnsTopic: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  }>;
}> {
  const store = await readStore();
  const devices = Object.values(store.devices ?? {}).filter((device) => device.pushKind === "apns");
  const readiness = await apnsReadiness();
  const config = await apnsConfig();
  let sent = 0;
  const now = new Date().toISOString();

  if (!config) {
    for (const device of devices) {
      device.lastError = readiness.apnsIssues[0] ?? "APNs is not configured";
      device.updatedAt = now;
    }
    await writeStore(store);
  } else {
    for (const device of devices) {
      try {
        await sendApnsToDevice(config, device, {
          type: "apns-probe",
          title: "prtl",
          body: "APNs delivery probe",
          url: "/",
          tag: "apns-probe",
          createdAt: now
        });
        device.lastSuccessAt = new Date().toISOString();
        device.lastError = null;
        device.updatedAt = device.lastSuccessAt;
        sent += 1;
      } catch (error) {
        device.lastError = error instanceof Error ? error.message : "APNs failed";
        device.updatedAt = new Date().toISOString();
      }
    }
    await writeStore(store);
  }

  return {
    configured: Boolean(config),
    environment: readiness.apnsEnvironment,
    topic: readiness.apnsTopic,
    deviceCount: devices.length,
    sent,
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      apnsTopic: device.apnsTopic ?? null,
      lastSuccessAt: device.lastSuccessAt,
      lastError: device.lastError
    }))
  };
}

export async function sendRequestNotification(request: RequestRecord): Promise<RequestRecord> {
  const sent = await sendUnifiedPayload(requestPayload(request));
  if (sent === 0) return request;
  return (await markRequestNotificationSent(request.id)) ?? request;
}

export async function sendPushPayload(payload: Record<string, unknown>): Promise<number> {
  const store = await readStore();
  const records = Object.values(store.notificationSubscriptions);
  if (!records.length) return 0;
  const keys = await ensureVapidKeys();
  webpush.setVapidDetails(PUBLIC_BASE_URL, keys.publicKey, keys.privateKey);
  let sent = 0;
  for (const record of records) {
    try {
      await webpush.sendNotification(record.subscription as webpush.PushSubscription, JSON.stringify(payload));
      record.lastSuccessAt = new Date().toISOString();
      record.lastError = null;
      record.updatedAt = record.lastSuccessAt;
      sent += 1;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : null;
      if (statusCode === 404 || statusCode === 410) {
        delete store.notificationSubscriptions[record.id];
      } else {
        record.lastError = error instanceof Error ? error.message : "Push failed";
        record.updatedAt = new Date().toISOString();
      }
    }
  }
  await writeStore(store);
  return sent;
}

async function sendUnifiedPayload(payload: Record<string, unknown>): Promise<number> {
  const [webPushSent, apnsSent] = await Promise.all([sendPushPayload(payload), sendApnsPayload(payload)]);
  return webPushSent + apnsSent;
}

async function sendApnsPayload(payload: Record<string, unknown>): Promise<number> {
  const store = await readStore();
  const devices = Object.values(store.devices ?? {}).filter((device) => device.pushKind === "apns");
  if (!devices.length) return 0;
  const config = await apnsConfig();
  if (!config) {
    const now = new Date().toISOString();
    for (const device of devices) {
      device.lastError = "APNs is not configured";
      device.updatedAt = now;
    }
    await writeStore(store);
    return 0;
  }
  let sent = 0;
  for (const device of devices) {
    try {
      await sendApnsToDevice(config, device, payload);
      device.lastSuccessAt = new Date().toISOString();
      device.lastError = null;
      device.updatedAt = device.lastSuccessAt;
      sent += 1;
    } catch (error) {
      device.lastError = error instanceof Error ? error.message : "APNs failed";
      device.updatedAt = new Date().toISOString();
    }
  }
  await writeStore(store);
  return sent;
}

async function markNotificationSent(id: string): Promise<FeedbackRequest | null> {
  const store = await readStore();
  const request = store.feedback[id];
  if (!request) return null;
  const notifiedAt = request.notifiedAt ?? new Date().toISOString();
  const next = {
    ...request,
    notifiedAt,
    metrics: {
      ...request.metrics,
      notifiedAt,
      requestToNotifyMs: diffMs(request.createdAt, notifiedAt)
    }
  };
  store.feedback[id] = next;
  await writeStore(store);
  return next;
}

async function markRequestNotificationSent(id: string): Promise<RequestRecord | null> {
  const store = await readStore();
  const request = store.requests?.[id];
  if (!request) return null;
  const notifiedAt = request.notifiedAt ?? new Date().toISOString();
  const next = {
    ...request,
    notifiedAt,
    updatedAt: notifiedAt
  };
  store.requests[id] = next;
  await writeStore(store);
  return next;
}

async function ensureVapidKeys(): Promise<VapidKeys> {
  try {
    return JSON.parse(await fs.readFile(pushPath, "utf8")) as VapidKeys;
  } catch {
    const keys = webpush.generateVAPIDKeys();
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(pushPath, `${JSON.stringify(keys, null, 2)}\n`, "utf8");
    return keys;
  }
}

function feedbackUrl(request: FeedbackRequest): string {
  const params = new URLSearchParams({ path: request.appPath, feedback: request.id });
  return `/view/${encodeURIComponent(request.resolvedProjectId ?? request.projectId)}?${params.toString()}`;
}

function feedbackPayload(request: FeedbackRequest): Record<string, unknown> {
  return {
    type: "feedback",
    feedbackId: request.id,
    projectId: request.resolvedProjectId ?? request.projectId,
    projectName: request.projectName,
    title: `Feedback: ${request.projectName}`,
    body: request.prompt,
    request: request.prompt,
    appPath: request.appPath,
    url: feedbackUrl(request),
    createdAt: request.createdAt
  };
}

export function requestPayload(request: RequestRecord): Record<string, unknown> {
  const fallbackUrl = request.target.url || (request.target.projectId
    ? `/view/${encodeURIComponent(request.target.projectId)}?${new URLSearchParams({ path: request.target.appPath ?? "/" }).toString()}`
    : "/");
  const url = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/r/${encodeURIComponent(request.id)}` : fallbackUrl;
  return {
    type: request.kind,
    requestId: request.id,
    title: request.title,
    body: request.body || request.prompt,
    request: request.prompt,
    choices: request.choices,
    allowText: request.allowText,
    projectId: request.target.projectId,
    projectName: request.target.projectName,
    url,
    tag: `request:${request.id}`,
    requireInteraction: request.priority !== "low",
    renotify: true,
    createdAt: request.createdAt,
    richAttachment: richNotificationAttachment(request)
  };
}

function richNotificationAttachment(request: RequestRecord): Record<string, unknown> | undefined {
  const attachment = request.attachments.find((item) => item.type === "image" && item.url);
  if (!attachment) return undefined;
  return {
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
    contentType: attachment.contentType,
    url: absolutePublicUrl(attachment.url)
  };
}

function absolutePublicUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, PUBLIC_BASE_URL).toString();
}

interface ApnsConfig {
  teamId: string;
  keyId: string;
  topic: string;
  key: string;
  host: string;
}

interface ApnsReadiness {
  apnsConfigured: boolean;
  apnsEnvironment: "sandbox" | "production";
  apnsTopic: string | null;
  apnsKeyConfigured: boolean;
  apnsKeyReadable: boolean;
  apnsMissing: string[];
  apnsIssues: string[];
}

export async function apnsReadiness(): Promise<ApnsReadiness> {
  const env = process.env.PRTL_APNS_ENV;
  const environment = env === "production" ? "production" : "sandbox";
  const apnsMissing = ["PRTL_APNS_TEAM_ID", "PRTL_APNS_KEY_ID", "PRTL_APNS_KEY_PATH", "PRTL_APNS_TOPIC"]
    .filter((key) => !process.env[key]);
  const apnsIssues = [...apnsMissing];
  if (env && env !== "sandbox" && env !== "production") {
    apnsIssues.push("PRTL_APNS_ENV must be sandbox or production");
  }

  let apnsKeyReadable = false;
  if (process.env.PRTL_APNS_KEY_PATH) {
    try {
      await fs.access(process.env.PRTL_APNS_KEY_PATH);
      apnsKeyReadable = true;
    } catch {
      apnsIssues.push("PRTL_APNS_KEY_PATH is not readable");
    }
  }

  return {
    apnsConfigured: apnsIssues.length === 0,
    apnsEnvironment: environment,
    apnsTopic: process.env.PRTL_APNS_TOPIC ?? null,
    apnsKeyConfigured: Boolean(process.env.PRTL_APNS_KEY_PATH),
    apnsKeyReadable,
    apnsMissing,
    apnsIssues
  };
}

async function apnsConfig(): Promise<ApnsConfig | null> {
  const teamId = process.env.PRTL_APNS_TEAM_ID;
  const keyId = process.env.PRTL_APNS_KEY_ID;
  const keyPath = process.env.PRTL_APNS_KEY_PATH;
  const topic = process.env.PRTL_APNS_TOPIC;
  const env = process.env.PRTL_APNS_ENV ?? "sandbox";
  if (!teamId || !keyId || !keyPath || !topic || !["sandbox", "production"].includes(env)) return null;
  let key: string;
  try {
    key = await fs.readFile(keyPath, "utf8");
  } catch {
    return null;
  }
  return {
    teamId,
    keyId,
    topic,
    key,
    host: env === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com"
  };
}

async function sendApnsToDevice(config: ApnsConfig, device: DeviceRecord, payload: Record<string, unknown>): Promise<void> {
  const token = apnsJwt(config);
  const aps: Record<string, unknown> = {
    alert: {
      title: String(payload.title ?? "prtl"),
      body: String(payload.body ?? payload.request ?? "Open prtl")
    },
    sound: "default",
    category: apnsCategory(payload),
    "thread-id": String(payload.tag ?? payload.requestId ?? "prtl")
  };
  if (payload.richAttachment) {
    aps["mutable-content"] = 1;
  }
  const body = JSON.stringify({
    aps,
    prtl: payload
  });
  await new Promise<void>((resolve, reject) => {
    const client = http2.connect(`https://${config.host}`);
    const chunks: Buffer[] = [];
    let status = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error("APNs request timed out")), 10000);

    client.on("error", (error) => finish(error));

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${device.token}`,
      authorization: `bearer ${token}`,
      "apns-topic": apnsTopicForDevice(config, device),
      "apns-push-type": "alert",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body))
    });

    req.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (status >= 200 && status < 300) finish();
      else finish(new Error(`APNs ${status || "unknown"}: ${Buffer.concat(chunks).toString("utf8")}`));
    });
    req.on("error", (error) => finish(error));
    req.end(body);
  });
}

export function apnsJwt(config: Pick<ApnsConfig, "teamId" | "keyId" | "key">): string {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64Url(JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }));
  const input = `${header}.${claims}`;
  const signature = derToJose(crypto.sign("sha256", Buffer.from(input), config.key), 32);
  return `${input}.${base64Url(signature)}`;
}

export function apnsCategory(payload: Record<string, unknown>): string {
  if (Array.isArray(payload.choices) && payload.choices.length) {
    return apnsChoiceCategory(payload.choices);
  }
  if (payload.allowText) return "PRTL_TEXT";
  return "PRTL_OPEN";
}

export function apnsTopicForDevice(config: { topic: string }, device: Pick<DeviceRecord, "apnsTopic">): string {
  return device.apnsTopic?.trim() || config.topic;
}

function apnsChoiceCategory(choices: unknown[]): string {
  const [first = "", second = ""] = choices.map((choice) => normalizeChoiceTitle(String(choice)));
  if (first === "approve" && second === "hold") return "PRTL_APPROVE_HOLD";
  if (first === "approve" && second === "reject") return "PRTL_APPROVE_REJECT";
  if (first === "allow" && second === "deny") return "PRTL_ALLOW_DENY";
  if (first === "yes" && second === "no") return "PRTL_YES_NO";
  if (first === "ship" && second === "hold" && normalizeChoiceTitle(String(choices[2] ?? "")) === "revise") return "PRTL_SHIP_HOLD_REVISE";
  if (first === "ship" && second === "hold") return "PRTL_SHIP_HOLD";
  if ((first === "use" || first === "use it") && second === "revise") return "PRTL_USE_REVISE";
  return "PRTL_CHOICE";
}

function normalizeChoiceTitle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function derToJose(signature: Buffer, bytes: number): Buffer {
  let offset = 0;
  if (signature[offset++] !== 0x30) throw new Error("Invalid ECDSA signature sequence");
  ({ offset } = readDerLength(signature, offset));
  if (signature[offset++] !== 0x02) throw new Error("Invalid ECDSA signature r marker");
  const rLength = readDerLength(signature, offset);
  offset = rLength.offset;
  const r = normalizeInteger(signature.subarray(offset, offset + rLength.length), bytes);
  offset += rLength.length;
  if (signature[offset++] !== 0x02) throw new Error("Invalid ECDSA signature s marker");
  const sLength = readDerLength(signature, offset);
  offset = sLength.offset;
  const s = normalizeInteger(signature.subarray(offset, offset + sLength.length), bytes);
  return Buffer.concat([leftPad(r, bytes), leftPad(s, bytes)]);
}

function readDerLength(buffer: Buffer, offset: number): { length: number; offset: number } {
  const first = buffer[offset++];
  if (first < 0x80) return { length: first, offset };
  const bytes = first & 0x7f;
  let length = 0;
  for (let index = 0; index < bytes; index += 1) {
    length = (length << 8) | buffer[offset++];
  }
  return { length, offset };
}

function normalizeInteger(buffer: Buffer, bytes: number): Buffer {
  let value = buffer;
  while (value.length > bytes && value[0] === 0) value = value.subarray(1);
  if (value.length > bytes) throw new Error("Invalid ECDSA signature integer length");
  return value;
}

function leftPad(buffer: Buffer, bytes: number): Buffer {
  if (buffer.length >= bytes) return buffer;
  return Buffer.concat([Buffer.alloc(bytes - buffer.length), buffer]);
}

async function latestActiveFeedback(): Promise<FeedbackRequest | null> {
  const store = await readStore();
  return Object.values(store.feedback)
    .filter((request) => request.projectAvailable)
    .filter((request) => ["open", "viewed", "stale"].includes(request.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

async function latestActiveRequest(): Promise<RequestRecord | null> {
  const store = await readStore();
  return Object.values(store.requests ?? {})
    .filter((request) => ["open", "viewed", "stale"].includes(request.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

function subscriptionId(endpoint: string): string {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

function diffMs(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
}
