import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changePlan, handleStripeWebhook } from "./billing";

const accountId = "11111111-1111-4111-8111-111111111111";
const secret = "whsec_local_billing_test";
const databases = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  sqlite.prepare("INSERT INTO accounts(account_id, email, created_at, updated_at) VALUES (?, ?, 1, 1)")
    .run(accountId, "billing@example.test");
  function prepare(sql, values = []) {
    return {
      bind: (...args) => prepare(sql, args),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
    };
  }
  const f = {
    sqlite,
    subscriptions: [],
    stripeStatus: 200,
    beforeResponse: undefined,
    beforeBatch: undefined,
    account: () => sqlite.prepare("SELECT * FROM accounts WHERE account_id = ?").get(accountId),
    processed: () => sqlite.prepare("SELECT id FROM stripe_events ORDER BY id").all().map((row) => row.id),
  };
  f.env = {
    ENVIRONMENT: "production",
    DEFAULT_PRICE_ID: "price_default",
    HIGH_PRICE_ID: "price_high",
    USAGE_PRICE_ID: "price_usage",
    STRIPE_SECRET_KEY: "test-only-api-key",
    STRIPE_WEBHOOK_SECRET: secret,
    DB: {
      prepare,
      batch: async (statements) => {
        await f.beforeBatch?.();
        sqlite.exec("BEGIN");
        try {
          const result = [];
          for (const statement of statements) result.push(await statement.run());
          sqlite.exec("COMMIT");
          return result;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  f.fetch = vi.fn(async (url, options) => {
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://api.stripe.com/v1/subscriptions");
    expect(parsed.searchParams.get("customer")).toBe("cus_nib");
    expect(parsed.searchParams.get("status")).toBe("all");
    expect(options.method ?? "GET").toBe("GET");
    const subscriptions = structuredClone(f.subscriptions);
    await f.beforeResponse?.();
    return Response.json({ data: subscriptions, has_more: false }, { status: f.stripeStatus });
  });
  vi.stubGlobal("fetch", f.fetch);
  return f;
}

function subscription(id = "sub_current", status = "active", plan = "default", created = 1) {
  return {
    id, status, created, customer: "cus_nib", metadata: { account_id: accountId, plan },
    items: { data: [
      { id: `si_${id}`, price: { id: `price_${plan}`, recurring: { usage_type: "licensed" } } },
      { id: "si_usage", price: { id: "price_usage", recurring: { usage_type: "metered" } } },
    ] },
  };
}

function checkout(subscriptionId = "sub_current", plan = "default") {
  return { id: "cs_checkout", mode: "subscription", customer: "cus_nib", subscription: subscriptionId,
    client_reference_id: accountId, metadata: { account_id: accountId, plan }, payment_status: "paid" };
}

function request(id, type, object) {
  const payload = JSON.stringify({ id, type, livemode: true, data: { object } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return new Request("https://nib.example/billing/webhook", { method: "POST", body: payload,
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` } });
}

describe("Stripe webhook lifecycle with migrated SQLite", () => {
  it("activates a paid subscription from current Stripe state and deduplicates delivery", async () => {
    const f = fixture();
    f.subscriptions = [subscription()];
    const send = () => handleStripeWebhook(request("evt_active", "customer.subscription.created", subscription()), f.env);
    expect((await send()).status).toBe(200);
    expect(f.account()).toMatchObject({ stripe_subscription_id: "sub_current", stripe_recurring_item_id: "si_sub_current" });
    expect((await send()).status).toBe(200);
    expect(f.processed()).toEqual(["evt_active"]);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("does not restore canceled access when checkout arrives late", async () => {
    const f = fixture();
    f.subscriptions = [subscription("sub_old", "canceled")];
    await handleStripeWebhook(request("evt_deleted", "customer.subscription.deleted", subscription("sub_old", "canceled")), f.env);
    await handleStripeWebhook(request("evt_checkout", "checkout.session.completed", checkout("sub_old")), f.env);
    expect(f.account().stripe_subscription_id).toBeNull();
    expect(f.account().stripe_recurring_item_id).toBeNull();
  });

  it("preserves the replacement when an older subscription is canceled", async () => {
    const f = fixture();
    f.subscriptions = [subscription("sub_new", "active", "high", 2), subscription("sub_old", "canceled")];
    await handleStripeWebhook(request("evt_new", "customer.subscription.created", subscription("sub_new", "active", "high", 2)), f.env);
    await handleStripeWebhook(request("evt_old_deleted", "customer.subscription.deleted", subscription("sub_old", "canceled")), f.env);
    expect(f.account()).toMatchObject({ plan: "high", stripe_subscription_id: "sub_new", stripe_recurring_item_id: "si_sub_new" });
  });

  it("uses current prices rather than stale checkout plan metadata", async () => {
    const f = fixture();
    f.subscriptions = [subscription("sub_current", "active", "high")];
    await handleStripeWebhook(request("evt_high", "customer.subscription.updated", subscription("sub_current", "active", "high")), f.env);
    await handleStripeWebhook(request("evt_old_checkout", "checkout.session.completed", checkout()), f.env);
    expect(f.account().plan).toBe("high");
  });

  it("lets reconciled subscription state own plan changes", async () => {
    const f = fixture();
    f.subscriptions = [subscription()];
    await handleStripeWebhook(request("evt_plan_initial", "customer.subscription.created", subscription()), f.env);
    const update = vi.fn().mockResolvedValue(Response.json(subscription("sub_current", "active", "high")));
    vi.stubGlobal("fetch", update);
    const response = await changePlan(new Request("https://nib.example/billing/plan", {
      method: "POST", body: JSON.stringify({ plan: "high" }),
    }), accountId, f.env);
    expect(response.status).toBe(200);
    expect(f.account().plan).toBe("default");
    expect(new URLSearchParams(update.mock.calls[0][1].body).get("items[0][price]")).toBe("price_high");
    f.subscriptions = [subscription("sub_current", "active", "high")];
    vi.stubGlobal("fetch", f.fetch);
    await handleStripeWebhook(request("evt_plan_updated", "customer.subscription.updated", f.subscriptions[0]), f.env);
    expect(f.account().plan).toBe("high");
  });

  it("reads every subscription page before revoking access", async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => Response.json({ data: [subscription("sub_canceled", "canceled")], has_more: true }));
    f.fetch.mockImplementationOnce(async (url) => {
      expect(new URL(url).searchParams.get("starting_after")).toBe("sub_canceled");
      return Response.json({ data: [subscription()], has_more: false });
    });
    await handleStripeWebhook(request("evt_pages", "customer.subscription.deleted", subscription("sub_canceled", "canceled")), f.env);
    expect(f.account().stripe_subscription_id).toBe("sub_current");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not link an existing account to another Stripe customer", async () => {
    const f = fixture();
    f.sqlite.prepare("UPDATE accounts SET stripe_customer_id = 'cus_other'").run();
    expect((await handleStripeWebhook(request("evt_wrong_customer", "checkout.session.completed", checkout()), f.env)).status).toBe(409);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.processed()).toEqual([]);
    expect(f.account().stripe_customer_id).toBe("cus_other");
  });

  it("accepts any valid v1 signature during signing-key rotation", async () => {
    const f = fixture();
    f.subscriptions = [subscription()];
    const signed = request("evt_rotation", "customer.subscription.created", subscription());
    signed.headers.append("stripe-signature", `v1=${"0".repeat(64)}`);
    expect((await handleStripeWebhook(signed, f.env)).status).toBe(200);
    expect(f.account().stripe_subscription_id).toBe("sub_current");
  });

  it("rejects unsigned input before contacting Stripe or changing state", async () => {
    const f = fixture();
    const signed = request("evt_unsigned", "customer.subscription.created", subscription());
    signed.headers.delete("stripe-signature");
    expect((await handleStripeWebhook(signed, f.env)).status).toBe(400);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.processed()).toEqual([]);
  });

  it("does not trust an old active event after Stripe has canceled the subscription", async () => {
    const f = fixture();
    f.subscriptions = [subscription("sub_current", "canceled")];
    await handleStripeWebhook(request("evt_stale_active", "customer.subscription.updated", subscription()), f.env);
    expect(f.account().stripe_subscription_id).toBeNull();
  });

  it("does not grant Nib access for an unrelated recurring product", async () => {
    const f = fixture();
    f.subscriptions = [subscription("sub_foreign", "active", "unrelated")];
    await handleStripeWebhook(request("evt_foreign", "customer.subscription.created", f.subscriptions[0]), f.env);
    expect(f.account().stripe_subscription_id).toBeNull();
  });

  it("retries provider failures without applying or recording the event", async () => {
    const f = fixture();
    f.stripeStatus = 503;
    await expect(handleStripeWebhook(request("evt_retry", "checkout.session.completed", checkout()), f.env)).rejects.toThrow();
    expect(f.processed()).toEqual([]);
    expect(f.account().stripe_subscription_id).toBeNull();
    f.stripeStatus = 200;
    f.subscriptions = [subscription()];
    await handleStripeWebhook(request("evt_retry", "checkout.session.completed", checkout()), f.env);
    expect(f.processed()).toEqual(["evt_retry"]);
    expect(f.account().stripe_subscription_id).toBe("sub_current");
  });

  it("rolls back access if recording the event fails", async () => {
    const f = fixture();
    f.subscriptions = [subscription()];
    f.sqlite.exec("CREATE TRIGGER fail_event BEFORE INSERT ON stripe_events BEGIN SELECT RAISE(ABORT, 'event storage unavailable'); END");
    await expect(handleStripeWebhook(request("evt_atomic", "customer.subscription.created", subscription()), f.env)).rejects.toThrow();
    expect(f.account().stripe_subscription_id).toBeNull();
    expect(f.processed()).toEqual([]);
    f.sqlite.exec("DROP TRIGGER fail_event");
    await handleStripeWebhook(request("evt_atomic", "customer.subscription.created", subscription()), f.env);
    expect(f.account().stripe_subscription_id).toBe("sub_current");
  });

  it("does not commit a stale Stripe response over a concurrent cancellation", async () => {
    const f = fixture();
    f.subscriptions = [subscription()];
    f.beforeResponse = async () => {
      f.beforeResponse = undefined;
      f.subscriptions = [subscription("sub_current", "canceled")];
      await handleStripeWebhook(request("evt_cancel_concurrent", "customer.subscription.deleted", f.subscriptions[0]), f.env);
    };
    await expect(handleStripeWebhook(request("evt_stale_concurrent", "customer.subscription.updated", subscription()), f.env)).rejects.toThrow();
    expect(f.account().stripe_subscription_id).toBeNull();
    expect(f.processed()).toEqual(["evt_cancel_concurrent"]);
    await handleStripeWebhook(request("evt_stale_concurrent", "customer.subscription.updated", subscription()), f.env);
    expect(f.account().stripe_subscription_id).toBeNull();
  });
});
