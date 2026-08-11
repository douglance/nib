import { describe, expect, it } from "vitest";
import { networkCohort, trialClaimError, trialNetworkHash, trialRequestError } from "./trial-policy";
import type { GenerationRequest } from "./types";

const fastTrial: GenerationRequest = {
  prompt: "A focused account screen",
  references: [],
  quality: "fast",
  aspect: "16:9",
  resolution: "1K",
  format: "png",
  background: false,
};

describe("free trial", () => {
  it("allows one blocking Fast 1K request shape", () => {
    expect(trialRequestError(fastTrial)).toBeUndefined();
  });

  it("rejects paid presets and background work", () => {
    expect(trialRequestError({ ...fastTrial, quality: "standard", resolution: "2K" })).toBe("FREE_TRIAL_FAST_1K_ONLY");
    expect(trialRequestError({ ...fastTrial, background: true })).toBe("FREE_TRIAL_BLOCKING_ONLY");
  });

  it("groups IPv4 by /24 and IPv6 by /64 without retaining a full address", () => {
    expect(networkCohort("203.0.113.47")).toBe("v4:203.0.113.0/24");
    expect(networkCohort("2001:db8:abcd:12::1234")).toBe("v6:2001:db8:abcd:12::/64");
    expect(networkCohort("not-an-ip")).toBeUndefined();
  });

  it("hashes a network cohort with a deployment secret", async () => {
    const first = await trialNetworkHash(new Request("https://example.test", { headers: { "cf-connecting-ip": "203.0.113.10" } }), "test-secret");
    const sameCohort = await trialNetworkHash(new Request("https://example.test", { headers: { "cf-connecting-ip": "203.0.113.240" } }), "test-secret");
    const otherCohort = await trialNetworkHash(new Request("https://example.test", { headers: { "cf-connecting-ip": "203.0.114.10" } }), "test-secret");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(sameCohort).toBe(first);
    expect(otherCohort).not.toBe(first);
  });

  it("limits distinct trial identities per network and per day", () => {
    expect(trialClaimError({ existingIdentity: false, networkClaims: 2, dailyClaims: 49 }, { networkMax: 3, dailyMax: 50 })).toBeUndefined();
    expect(trialClaimError({ existingIdentity: false, networkClaims: 3, dailyClaims: 1 }, { networkMax: 3, dailyMax: 50 })).toBe("FREE_TRIAL_NETWORK_LIMIT");
    expect(trialClaimError({ existingIdentity: false, networkClaims: 0, dailyClaims: 50 }, { networkMax: 3, dailyMax: 50 })).toBe("FREE_TRIAL_DAILY_LIMIT");
  });

  it("lets an existing identity retry without consuming another claim", () => {
    expect(trialClaimError({ existingIdentity: true, networkClaims: 99, dailyClaims: 99 }, { networkMax: 3, dailyMax: 50 })).toBeUndefined();
  });
});
