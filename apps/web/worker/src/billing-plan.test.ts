import { afterEach, describe, expect, it, vi } from "vitest";
import { billingStatus, changePlan } from "./billing";
import type { Env } from "./types";

afterEach(() => vi.unstubAllGlobals());

function fixture(subscribed = true) {
  const account = {
    plan: "default", stripe_customer_id: subscribed ? "cus_nib" : null,
    stripe_subscription_id: subscribed ? "sub_nib" : null,
    stripe_recurring_item_id: subscribed ? "si_base" : null,
  };
  const first = vi.fn().mockResolvedValue(account);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "sub_nib", status: "active" }));
  vi.stubGlobal("fetch", fetchMock);
  const env = {
    PUBLIC_ORIGIN: "https://nibtool.com", DEFAULT_PRICE_ID: "price_default",
    HIGH_PRICE_ID: "price_high", STRIPE_SECRET_KEY: "test-only", DB: { prepare },
  } as unknown as Env;
  return { env, account, first, bind, prepare, fetchMock };
}

function form(plan: string) {
  return new Request("https://nibtool.com/billing/plan", {
    method: "POST", headers: { accept: "text/html" }, body: new URLSearchParams({ plan }),
  });
}

describe("web plan switching", () => {
  it.each(["default", "high"])("accepts a form for %s and returns pending confirmation, not active access", async plan => {
    const f = fixture();
    const response = await changePlan(form(plan), "account-123", f.env);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`https://nibtool.com/account?plan_change=submitted&plan=${plan}`);
    const [url, options] = f.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/subscriptions/sub_nib");
    expect(Object.fromEntries(options.body)).toEqual({
      "items[0][id]": "si_base", "items[0][price]": `price_${plan}`,
      "metadata[plan]": plan, proration_behavior: "create_prorations",
    });
    expect(f.bind).toHaveBeenCalledWith("account-123");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.account.plan).toBe("default");
  });

  it("preserves the JSON API response", async () => {
    const f = fixture();
    const response = await changePlan(new Request("https://nibtool.com/billing/plan", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "high" }),
    }), "account-123", f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "sub_nib", status: "active" });
  });

  it.each(["{}", "null", "{", '{"plan":"enterprise"}'])("rejects invalid JSON input without calling Stripe: %s", async body => {
    const f = fixture();
    const response = await changePlan(new Request("https://nibtool.com/billing/plan", { method: "POST", body }), "account-123", f.env);
    expect(response.status).toBe(400);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("redirects a malformed form to a safe error state", async () => {
    const f = fixture();
    const response = await changePlan(form("https://evil.example"), "account-123", f.env);
    expect(response.headers.get("location")).toBe("https://nibtool.com/account?plan_change=invalid");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("does not subscribe an unpaid account through the plan-change form", async () => {
    const f = fixture(false);
    const response = await changePlan(form("high"), "account-123", f.env);
    expect(response.headers.get("location")).toBe("https://nibtool.com/account?plan_change=no_subscription");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("does not label a rejected Stripe mutation as submitted", async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValue(Response.json({ error: "request rejected" }, { status: 400 }));
    const response = await changePlan(form("high"), "account-123", f.env);
    expect(response.headers.get("location")).toBe("https://nibtool.com/account?plan_change=failed");
  });

  it("treats Stripe server errors as an unknown mutation outcome", async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValue(Response.json({ error: "provider unavailable" }, { status: 500 }));
    const response = await changePlan(form("high"), "account-123", f.env);
    expect(response.headers.get("location")).toBe("https://nibtool.com/account?plan_change=unknown");
  });

  it("returns an unknown outcome after a lost response without retrying the mutation", async () => {
    const f = fixture();
    f.fetchMock.mockRejectedValue(new Error("connection lost"));
    const response = await changePlan(form("high"), "account-123", f.env);
    expect(response.headers.get("location")).toBe("https://nibtool.com/account?plan_change=unknown");
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });
});

describe("private billing status", () => {
  it("returns only the authenticated account's reconciled plan without caching", async () => {
    const f = fixture();
    const response = await billingStatus("account-123", f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ subscribed: true, plan: "default", hasBillingCustomer: true });
    expect(f.bind).toHaveBeenCalledWith("account-123");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("distinguishes an unsubscribed account from a paid Default plan", async () => {
    const f = fixture(false);
    const response = await billingStatus("account-123", f.env);
    expect(await response.json()).toEqual({ subscribed: false, plan: "default", hasBillingCustomer: false });
  });

  it("keeps invoice-portal availability distinct from an active subscription", async () => {
    const f = fixture(false);
    f.account.stripe_customer_id = "cus_previous_subscription";
    const response = await billingStatus("account-123", f.env);
    expect(await response.json()).toEqual({ subscribed: false, plan: "default", hasBillingCustomer: true });
  });

  it("returns 404 if the account was deleted after authentication", async () => {
    const f = fixture();
    f.first.mockResolvedValue(null);
    const response = await billingStatus("account-123", f.env);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
