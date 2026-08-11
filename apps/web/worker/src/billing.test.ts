import { describe, expect, it } from "vitest";
import {
  buildCheckoutForm,
  buildPortalForm,
  isActiveSubscriptionStatus,
  subscriptionEntitlement,
} from "./billing";
import type { Env } from "./types";

const env = {
  PUBLIC_ORIGIN: "https://nib.example.com",
  DEFAULT_PRICE_ID: "price_default",
  HIGH_PRICE_ID: "price_high",
  USAGE_PRICE_ID: "price_usage",
  BILLING_PORTAL_CONFIGURATION_ID: "bpc_nib",
} as unknown as Env;

describe("Stripe checkout", () => {
  it("collects tax details and creates one subscription with metered usage", () => {
    const form = buildCheckoutForm("default", "person@example.com", env, null);

    expect(form.get("mode")).toBe("subscription");
    expect(form.get("success_url")).toBe(
      "https://nib.example.com/account?checkout=success",
    );
    expect(form.get("cancel_url")).toBe(
      "https://nib.example.com/pricing?checkout=cancelled",
    );
    expect(form.get("client_reference_id")).toBe("person@example.com");
    expect(form.get("billing_address_collection")).toBe("required");
    expect(form.get("automatic_tax[enabled]")).toBe("true");
    expect(form.get("tax_id_collection[enabled]")).toBe("true");
    expect(form.get("name_collection[individual][enabled]")).toBe("true");
    expect(form.get("line_items[0][price]")).toBe("price_default");
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("line_items[1][price]")).toBe("price_usage");
  });

  it("reuses and updates an existing Stripe customer", () => {
    const form = buildCheckoutForm(
      "high",
      "person@example.com",
      env,
      "cus_existing",
    );

    expect(form.get("customer")).toBe("cus_existing");
    expect(form.get("customer_update[address]")).toBe("auto");
    expect(form.get("customer_update[name]")).toBe("auto");
    expect(form.get("line_items[0][price]")).toBe("price_high");
  });
});

describe("Stripe billing portal", () => {
  it("pins sessions to the Nib portal configuration", () => {
    const form = buildPortalForm("cus_existing", env);

    expect(form.get("customer")).toBe("cus_existing");
    expect(form.get("configuration")).toBe("bpc_nib");
    expect(form.get("return_url")).toBe("https://nib.example.com/account");
  });
});

describe("subscription entitlement", () => {
  it("authorizes only active and trialing subscriptions", () => {
    expect(isActiveSubscriptionStatus("active")).toBe(true);
    expect(isActiveSubscriptionStatus("trialing")).toBe(true);

    for (const status of [
      "canceled",
      "incomplete",
      "incomplete_expired",
      "past_due",
      "paused",
      "unpaid",
    ]) {
      expect(isActiveSubscriptionStatus(status)).toBe(false);
    }
  });

  it("derives a complete entitlement from subscription events that arrive before checkout", () => {
    expect(
      subscriptionEntitlement(
        {
          id: "sub_123",
          customer: "cus_123",
          status: "active",
          metadata: { tenant_id: "person@example.com", plan: "high" },
          items: {
            data: [
              {
                id: "si_base",
                price: { id: "price_high", recurring: { usage_type: "licensed" } },
              },
              {
                id: "si_meter",
                price: { id: "price_usage", recurring: { usage_type: "metered" } },
              },
            ],
          },
        },
        env,
      ),
    ).toEqual({
      tenantId: "person@example.com",
      plan: "high",
      customerId: "cus_123",
      subscriptionId: "sub_123",
      recurringItemId: "si_base",
    });
  });

  it("clears paid identifiers for an inactive subscription", () => {
    expect(
      subscriptionEntitlement(
        {
          id: "sub_123",
          customer: "cus_123",
          status: "past_due",
          metadata: { tenant_id: "person@example.com", plan: "default" },
          items: { data: [] },
        },
        env,
      ),
    ).toEqual({
      tenantId: "person@example.com",
      plan: "default",
      customerId: "cus_123",
      subscriptionId: null,
      recurringItemId: null,
    });
  });
});
