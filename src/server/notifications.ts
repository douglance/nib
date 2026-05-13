import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";
import type { FeedbackRequest, NotificationSubscriptionRecord } from "../shared/types";
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
  return {
    vapidPublicKey: await getVapidPublicKey(),
    subscriptionCount: Object.keys(store.notificationSubscriptions).length
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
  await writeStore(store);
  return record;
}

export async function unsubscribeNotifications(endpoint: string): Promise<{ removed: boolean }> {
  const store = await readStore();
  const id = subscriptionId(endpoint);
  const removed = Boolean(store.notificationSubscriptions[id]);
  delete store.notificationSubscriptions[id];
  await writeStore(store);
  return { removed };
}

export async function sendFeedbackNotification(request: FeedbackRequest): Promise<FeedbackRequest> {
  if (!request.projectAvailable || !request.resolvedProjectId) return request;
  const sent = await sendPushPayload(feedbackPayload(request));
  if (sent === 0) return request;
  return (await markNotificationSent(request.id)) ?? request;
}

export async function sendTestNotification(): Promise<{ sent: number }> {
  const latest = await latestActiveFeedback();
  if (latest) {
    const sent = await sendPushPayload(feedbackPayload(latest));
    if (sent > 0) await markNotificationSent(latest.id);
    return { sent };
  }
  const sent = await sendPushPayload({
    type: "test",
    title: "prtl feedback",
    body: "No active feedback requests. Tap to open the feedback lab.",
    url: "/view/prtl-feedback-lab?path=%2Flab%2Ffeedback%2F",
    createdAt: new Date().toISOString()
  });
  return { sent };
}

async function sendPushPayload(payload: Record<string, unknown>): Promise<number> {
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

async function latestActiveFeedback(): Promise<FeedbackRequest | null> {
  const store = await readStore();
  return Object.values(store.feedback)
    .filter((request) => request.projectAvailable)
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
