import { describe, expect, it } from "vitest";
import {
  canonicalEmail,
  personalWorkspaceName,
  sessionLifetimeSeconds,
} from "./account";

describe("Nib account policy", () => {
  it("uses one canonical identity across devices", () => {
    expect(canonicalEmail("  Doug@Example.COM ")).toBe("doug@example.com");
  });

  it("derives a stable personal workspace label", () => {
    expect(personalWorkspaceName("doug@example.com")).toBe("Doug's Nib");
    expect(personalWorkspaceName("+@example.com")).toBe("My Nib");
  });

  it("keeps browser sessions for thirty rolling days", () => {
    expect(sessionLifetimeSeconds).toBe(60 * 60 * 24 * 30);
  });
});
