import crypto from "node:crypto";
import type { DevicePlatform, DeviceRecord } from "../shared/types";
import { readStore, writeStore } from "./store";

interface DeviceRegisterInput {
  name?: string;
  platform?: DevicePlatform;
  pushKind?: "webpush" | "apns";
  token?: string;
  apnsTopic?: string | null;
  userAgent?: string | null;
  capabilities?: string[];
}

export async function listDevices(): Promise<DeviceRecord[]> {
  const store = await readStore();
  return Object.values(store.devices ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function registerDevice(input: DeviceRegisterInput): Promise<DeviceRecord> {
  if (!input.token?.trim()) throw new Error("token is required");
  const now = new Date().toISOString();
  const pushKind = input.pushKind ?? "apns";
  const id = deviceId(pushKind, input.token);
  const store = await readStore();
  const existing = store.devices?.[id];
  const record: DeviceRecord = {
    id,
    name: input.name?.trim() || existing?.name || platformName(input.platform),
    platform: input.platform ?? existing?.platform ?? "unknown",
    pushKind,
    token: input.token.trim(),
    apnsTopic: pushKind === "apns" ? normalizeTopic(input.apnsTopic, existing?.apnsTopic) : null,
    userAgent: input.userAgent ?? existing?.userAgent ?? null,
    capabilities: normalizeCapabilities(input.capabilities, existing?.capabilities),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastError: null
  };
  store.devices[id] = record;
  await writeStore(store);
  return record;
}

export async function removeDevice(id: string): Promise<{ removed: boolean }> {
  const store = await readStore();
  const removed = Boolean(store.devices?.[id]);
  delete store.devices[id];
  await writeStore(store);
  return { removed };
}

function deviceId(kind: string, token: string): string {
  return crypto.createHash("sha256").update(`${kind}:${token}`).digest("hex");
}

function platformName(platform: DevicePlatform | undefined): string {
  if (platform === "ios") return "iPhone";
  if (platform === "visionos") return "Apple Vision Pro";
  if (platform === "watchos") return "Apple Watch";
  if (platform === "macos") return "Mac";
  if (platform === "web") return "Web";
  return "Device";
}

function normalizeCapabilities(input: string[] | undefined, existing: string[] | undefined): string[] {
  return [...new Set([...(input ?? []), ...(existing ?? [])].map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

function normalizeTopic(input: string | null | undefined, existing: string | null | undefined): string | null {
  return input?.trim() || existing?.trim() || null;
}
