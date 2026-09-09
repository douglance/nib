import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCheckoutForm,
  consumeMetering,
  isActiveSubscriptionStatus,
  subscriptionEntitlement,
} from "./billing";
import type { Env, MeterEvent } from "./types";

const env = {
  PUBLIC_ORIGIN: "https://nib.example.com",
  DEFAULT_PRICE_ID: "price_default",
  HIGH_PRICE_ID: "price_high",
  USAGE_PRICE_ID: "price_usage",
} as unknown as Env;

describe("usage meter delivery", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fixture(eventName: string | undefined, stripeStatus = 200) {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: stripeStatus }));
    vi.stubGlobal("fetch", fetchMock);
    const ledger = {
      identifier: "nib_job-123",
      account_id: "account-123",
      usage_cents: 12,
      state: "queued",
      created_at: 1234,
      first_attempt_at: null as number | null,
      stripe_event_name: null as string | null,
      stripe_customer_id: null as string | null,
      stripe_value: null as number | null,
      stripe_event_timestamp: null as number | null,
      reconciliation_required: 0,
      account_stripe_customer_id: "cus_123",
    };
    const run = vi.fn(async (sql: string, args: unknown[]) => {
      if (sql.includes("SET first_attempt_at = unixepoch()")) {
        ledger.first_attempt_at = Math.floor(Date.now() / 1000);
        ledger.stripe_event_name = String(args[0]);
        ledger.stripe_customer_id = String(args[1]);
        ledger.stripe_value = Number(args[2]);
        ledger.stripe_event_timestamp = Number(args[3]);
        return { success: true, meta: { changes: 1 } };
      }
      if (sql.includes("SET state = 'sent'")) {
        ledger.state = "sent";
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    });
    const prepare = vi.fn((sql: string, values: unknown[] = []) => ({
      bind: (...args: unknown[]) => prepare(sql, args),
      first: vi.fn(async () => {
        if (sql.includes("FROM usage_ledger")) return ledger;
        return null;
      }),
      run: () => run(sql, values),
    }));
    const message = {
      body: { identifier: "nib_job-123", tenantId: "account-123", stripeCustomerId: "cus_123", value: 12 },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    return {
      env: { ...env, STRIPE_USAGE_EVENT_NAME: eventName, STRIPE_SECRET_KEY: "test-key", DB: { prepare } } as unknown as Env,
      batch: { messages: [message] } as unknown as MessageBatch<MeterEvent>,
      message, fetchMock, prepare, run, ledger,
    };
  }

  it("sends usage to the configured Stripe meter before acknowledging delivery", async () => {
    const f = fixture("visualize_usage_cents");
    await consumeMetering(f.batch, f.env);
    expect(f.fetchMock).toHaveBeenCalledOnce();
    const call = f.fetchMock.mock.calls[0];
    if (!call) throw new Error("Expected a Stripe meter request");
    const [url, options] = call;
    expect(url).toBe("https://api.stripe.com/v1/billing/meter_events");
    expect(Object.fromEntries(options.body)).toEqual({
      event_name: "visualize_usage_cents",
      identifier: "nib_job-123",
      timestamp: "1234",
      "payload[stripe_customer_id]": "cus_123",
      "payload[value]": "12",
    });
    expect(new Headers(options.headers).get("Idempotency-Key")).toBe("nib-meter-nib_job-123");
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.message.ack).toHaveBeenCalledOnce();
    expect(f.message.retry).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("retries without sending when the meter is unconfigured: %s", async (name) => {
    const f = fixture(name);
    await consumeMetering(f.batch, f.env);
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.message.ack).not.toHaveBeenCalled();
    expect(f.message.retry).toHaveBeenCalledOnce();
  });

  it("keeps rejected Stripe events queued for retry", async () => {
    const f = fixture("visualize_usage_cents", 400);
    await consumeMetering(f.batch, f.env);
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(f.ledger.state).toBe("queued");
    expect(f.message.ack).not.toHaveBeenCalled();
    expect(f.message.retry).toHaveBeenCalledOnce();
  });
});

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
