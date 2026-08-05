import type { Plan, Quality, Resolution } from "./types";

export const PLAN_LIMITS: Record<Plan, { active: number; queued: number; perMinute: number; retentionDays: number; weight: number }> = {
  default: { active: 2, queued: 20, perMinute: 60, retentionDays: 7, weight: 1 },
  high: { active: 8, queued: 100, perMinute: 300, retentionDays: 30, weight: 4 },
};

export const MODEL_BY_QUALITY: Record<Quality, string> = {
  fast: "google/nano-banana-2-lite",
  standard: "google/nano-banana-2",
  pro: "google/nano-banana-pro",
};

export function usageCents(quality: Quality, resolution: Resolution): number {
  if (quality === "fast") {
    if (resolution !== "1K") throw new Error("fast quality only supports 1K");
    return 12;
  }
  if (quality === "standard") return { "1K": 22, "2K": 32, "4K": 48 }[resolution];
  return resolution === "4K" ? 75 : 43;
}
