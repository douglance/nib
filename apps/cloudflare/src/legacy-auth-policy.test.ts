import { describe, expect, it } from "vitest";
import { isLegacyAuthRoute } from "./legacy-auth-policy";

describe("legacy authentication cutover", () => {
  it("retires every direct legacy auth endpoint without blocking account-routed APIs", () => {
    expect(isLegacyAuthRoute("/api/auth/exchange")).toBe(true);
    expect(isLegacyAuthRoute("/api/auth/pairings")).toBe(true);
    expect(isLegacyAuthRoute("/api/auth/pairings/redeem")).toBe(true);
    expect(isLegacyAuthRoute("/api/auth/status")).toBe(true);
    expect(isLegacyAuthRoute("/api/auth/logout")).toBe(true);
    expect(isLegacyAuthRoute("/api/requests")).toBe(false);
  });
});
