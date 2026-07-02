import fs from "node:fs/promises";
import path from "node:path";
import type {
  ActivityEvent,
  CommandRun,
  DeviceRecord,
  FeedbackRequest,
  NotificationSubscriptionRecord,
  ProjectWorkspace,
  RequestAttachment,
  RequestRecord,
  RegisteredTarget,
  RouteMode,
  WaitingPane
} from "../shared/types";
import { ARTIFACT_DIR, ATTACHMENT_DIR, DATA_DIR, SCREENSHOT_DIR } from "./config";

export interface StoredProject {
  id: string;
  name?: string;
  hidden?: boolean;
  preferredRoute?: RouteMode;
  rootPath?: string;
  rewriteDisabled?: boolean;
  websocketDisabled?: boolean;
  healthPath?: string;
  notes?: string;
  lastKey: string;
}

export interface StoreShape {
  projects: Record<string, StoredProject>;
  workspaces: Record<string, ProjectWorkspace>;
  commands: Record<string, CommandRun[]>;
  feedback: Record<string, FeedbackRequest>;
  requests: Record<string, RequestRecord>;
  devices: Record<string, DeviceRecord>;
  attachments: Record<string, RequestAttachment>;
  targets: Record<string, RegisteredTarget>;
  notificationSubscriptions: Record<string, NotificationSubscriptionRecord>;
  waiting: Record<string, WaitingPane>;
  waitingUpdatedAt: string | null;
  activity: ActivityEvent[];
}

const storePath = path.join(DATA_DIR, "store.json");
let writeChain: Promise<void> = Promise.resolve();

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.mkdir(ATTACHMENT_DIR, { recursive: true });
}

export async function readStore(): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const store = JSON.parse(raw) as Partial<StoreShape>;
    return {
      projects: store.projects ?? {},
      workspaces: store.workspaces ?? {},
      commands: store.commands ?? {},
      feedback: store.feedback ?? {},
      requests: store.requests ?? {},
      devices: store.devices ?? {},
      attachments: store.attachments ?? {},
      targets: store.targets ?? {},
      notificationSubscriptions: store.notificationSubscriptions ?? {},
      waiting: store.waiting ?? {},
      waitingUpdatedAt: store.waitingUpdatedAt ?? null,
      activity: store.activity ?? []
    };
  } catch {
    return {
      projects: {},
      workspaces: {},
      commands: {},
      feedback: {},
      requests: {},
      devices: {},
      attachments: {},
      targets: {},
      notificationSubscriptions: {},
      waiting: {},
      waitingUpdatedAt: null,
      activity: []
    };
  }
}

export async function writeStore(store: StoreShape): Promise<void> {
  const nextWrite = writeChain.then(() => writeStoreNow(store));
  writeChain = nextWrite.catch(() => undefined);
  await nextWrite;
}

async function writeStoreNow(store: StoreShape): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  store.projects ??= {};
  store.workspaces ??= {};
  store.commands ??= {};
  store.feedback ??= {};
  store.requests ??= {};
  store.devices ??= {};
  store.attachments ??= {};
  store.targets ??= {};
  store.notificationSubscriptions ??= {};
  store.waiting ??= {};
  store.waitingUpdatedAt ??= null;
  store.activity ??= [];
  try {
    const latest = JSON.parse(await fs.readFile(storePath, "utf8")) as Partial<StoreShape>;
    store.feedback = mergeFeedback(latest.feedback ?? {}, store.feedback);
    store.requests = mergeTimestamped(latest.requests ?? {}, store.requests ?? {});
    store.devices = mergeTimestamped(latest.devices ?? {}, store.devices ?? {});
    store.attachments = { ...(latest.attachments ?? {}), ...(store.attachments ?? {}) };
    if (timestampValue(latest.waitingUpdatedAt) > timestampValue(store.waitingUpdatedAt)) {
      store.waiting = latest.waiting ?? {};
      store.waitingUpdatedAt = latest.waitingUpdatedAt ?? null;
    }
  } catch {
    // First write or corrupt local state; the caller's validated store is still usable.
  }
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function mergeTimestamped<T extends { updatedAt?: string; createdAt: string }>(
  latest: Record<string, T>,
  incoming: Record<string, T>
): Record<string, T> {
  const merged = { ...latest };
  for (const [id, item] of Object.entries(incoming)) {
    const current = merged[id];
    if (!current || timestamp(item) >= timestamp(current)) {
      merged[id] = item;
    }
  }
  return merged;
}

function timestamp(item: { updatedAt?: string; createdAt: string }): number {
  return timestampValue(item.updatedAt || item.createdAt);
}

function timestampValue(value: string | null | undefined): number {
  const time = new Date(value ?? "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function mergeFeedback(
  latest: Record<string, FeedbackRequest>,
  incoming: Record<string, FeedbackRequest>
): Record<string, FeedbackRequest> {
  const merged = { ...latest };
  for (const [id, request] of Object.entries(incoming)) {
    const current = merged[id];
    if (!current || feedbackTimestamp(request) >= feedbackTimestamp(current)) {
      merged[id] = request;
    }
  }
  return merged;
}

function feedbackTimestamp(request: FeedbackRequest): number {
  const value = new Date(request.updatedAt || request.createdAt).getTime();
  return Number.isFinite(value) ? value : 0;
}
