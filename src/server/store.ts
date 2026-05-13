import fs from "node:fs/promises";
import path from "node:path";
import type {
  ActivityEvent,
  CommandRun,
  FeedbackRequest,
  NotificationSubscriptionRecord,
  ProjectWorkspace,
  RegisteredTarget,
  RouteMode
} from "../shared/types";
import { ARTIFACT_DIR, DATA_DIR, SCREENSHOT_DIR } from "./config";

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
  targets: Record<string, RegisteredTarget>;
  notificationSubscriptions: Record<string, NotificationSubscriptionRecord>;
  activity: ActivityEvent[];
}

const storePath = path.join(DATA_DIR, "store.json");

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
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
      targets: store.targets ?? {},
      notificationSubscriptions: store.notificationSubscriptions ?? {},
      activity: store.activity ?? []
    };
  } catch {
    return { projects: {}, workspaces: {}, commands: {}, feedback: {}, targets: {}, notificationSubscriptions: {}, activity: [] };
  }
}

export async function writeStore(store: StoreShape): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  store.projects ??= {};
  store.workspaces ??= {};
  store.commands ??= {};
  store.feedback ??= {};
  store.targets ??= {};
  store.notificationSubscriptions ??= {};
  store.activity ??= [];
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
