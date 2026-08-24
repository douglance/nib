import type { BillingMode } from "./types";

export interface GenerationEntitlement {
  stripeSubscriptionId: string | null;
  unmeteredAccess: boolean;
}

export function generationBillingMode(
  environment: string,
  entitlement: GenerationEntitlement,
): BillingMode {
  return environment !== "production" || entitlement.stripeSubscriptionId || entitlement.unmeteredAccess
    ? "paid"
    : "trial";
}

export function shouldRecordUsage(entitlement: GenerationEntitlement): boolean {
  return !entitlement.unmeteredAccess;
}
