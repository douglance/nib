import { describe, expect, it } from "vitest";
import { generationBillingMode, shouldRecordUsage } from "./entitlement";

describe("generation entitlement", () => {
  it("authorizes unmetered production accounts without creating billable usage", () => {
    const entitlement = { stripeSubscriptionId: null, unmeteredAccess: true };

    expect(generationBillingMode("production", entitlement)).toBe("paid");
    expect(shouldRecordUsage(entitlement)).toBe(false);
  });

  it("keeps unsubscribed production accounts on the trial path", () => {
    const entitlement = { stripeSubscriptionId: null, unmeteredAccess: false };

    expect(generationBillingMode("production", entitlement)).toBe("trial");
    expect(shouldRecordUsage(entitlement)).toBe(true);
  });

  it("meters subscribed production accounts", () => {
    const entitlement = { stripeSubscriptionId: "sub_123", unmeteredAccess: false };

    expect(generationBillingMode("production", entitlement)).toBe("paid");
    expect(shouldRecordUsage(entitlement)).toBe(true);
  });
});
