import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortal } from "./billing";
import type { Env } from "./types";

describe("billing portal navigation", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fixture(customerId: string | null = "cus_existing", stripeStatus = 200) {
    const session = stripeStatus === 200
      ? { id: "bps_test", url: "https://billing.stripe.com/p/session/test" }
      : { error: { message: "Portal unavailable" } };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(session, { status: stripeStatus }));
    vi.stubGlobal("fetch", fetchMock);
    const first = vi.fn().mockResolvedValue({ stripe_customer_id: customerId });
    const bind = vi.fn().mockReturnValue({ first });
    const env = {
      PUBLIC_ORIGIN: "https://nibtool.com",
      STRIPE_SECRET_KEY: "test-key",
      STRIPE_PORTAL_CONFIGURATION_ID: "bpc_nib",
      DB: { prepare: vi.fn().mockReturnValue({ bind }) },
    } as unknown as Env;
    return { env, fetchMock, bind, session };
  }

  function request(accept: string) {
    return new Request("https://nibtool.com/billing/portal", {
      method: "POST", headers: { accept },
    });
  }

  it("redirects the account-page form to Stripe with a GET after POST", async () => {
    const f = fixture();
    const response = await createPortal("account-123", f.env, request("text/html,application/xhtml+xml"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(f.session.url);
    expect(f.bind).toHaveBeenCalledWith("account-123");
    const [url, options] = f.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(Object.fromEntries(options.body)).toEqual({
      customer: "cus_existing", return_url: "https://nibtool.com/account", configuration: "bpc_nib",
    });
  });

  it("preserves the session JSON for API clients", async () => {
    const f = fixture();
    const response = await createPortal("account-123", f.env, request("application/json"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(f.session);
  });

  it("does not redirect on a Stripe error", async () => {
    const f = fixture("cus_existing", 503);
    const response = await createPortal("account-123", f.env, request("text/html"));
    expect(response.status).toBe(503);
    expect(response.headers.has("location")).toBe(false);
  });

  it("does not create a portal session without a billing customer", async () => {
    const f = fixture(null);
    const response = await createPortal("account-123", f.env, request("text/html"));
    expect(response.status).toBe(404);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed instead of using another product's default portal", async () => {
    const f = fixture();
    f.env.STRIPE_PORTAL_CONFIGURATION_ID = "";
    const response = await createPortal("account-123", f.env, request("text/html"));
    expect(response.status).toBe(503);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
});
