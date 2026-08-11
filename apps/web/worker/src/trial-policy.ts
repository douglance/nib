import type { GenerationRequest } from "./types";

export type TrialErrorCode =
  | "FREE_TRIAL_FAST_1K_ONLY"
  | "FREE_TRIAL_BLOCKING_ONLY"
  | "FREE_TRIAL_NETWORK_LIMIT"
  | "FREE_TRIAL_DAILY_LIMIT";

interface TrialClaimSnapshot {
  existingIdentity: boolean;
  networkClaims: number;
  dailyClaims: number;
}

interface TrialLimits {
  networkMax: number;
  dailyMax: number;
}

export function trialRequestError(input: GenerationRequest): TrialErrorCode | undefined {
  if (input.quality !== "fast" || input.resolution !== "1K") return "FREE_TRIAL_FAST_1K_ONLY";
  if (input.background) return "FREE_TRIAL_BLOCKING_ONLY";
  return undefined;
}

export function trialClaimError(snapshot: TrialClaimSnapshot, limits: TrialLimits): TrialErrorCode | undefined {
  if (snapshot.existingIdentity) return undefined;
  if (snapshot.networkClaims >= limits.networkMax) return "FREE_TRIAL_NETWORK_LIMIT";
  if (snapshot.dailyClaims >= limits.dailyMax) return "FREE_TRIAL_DAILY_LIMIT";
  return undefined;
}

export function networkCohort(ip: string): string | undefined {
  const ipv4 = ip.split(".");
  if (ipv4.length === 4) {
    const octets = ipv4.map((value) => Number(value));
    if (octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
      return `v4:${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
    }
    return undefined;
  }

  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((value) => !/^[0-9a-f]{1,4}$/.test(value))) return undefined;
  const prefix = groups.slice(0, 4).map((value) => Number.parseInt(value, 16).toString(16));
  return `v6:${prefix.join(":")}::/64`;
}

export async function trialNetworkHash(request: Request, secret: string): Promise<string | undefined> {
  const ip = request.headers.get("cf-connecting-ip");
  const cohort = ip ? networkCohort(ip) : undefined;
  if (!cohort || !secret) return undefined;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(cohort));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
