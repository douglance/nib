import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NibAccount } from "./account-auth";
import worker from "./index";
import type { Env } from "./types";

const auth = vi.hoisted(() => ({
  account: undefined as NibAccount | undefined,
  handleAccountAuth: vi.fn(async () => null),
  verifiedAccount: vi.fn(async () => auth.account),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

vi.mock("./account-auth", () => ({
  handleAccountAuth: auth.handleAccountAuth,
  verifiedAccount: auth.verifiedAccount,
}));

beforeEach(() => {
  auth.account = undefined;
  auth.handleAccountAuth.mockClear();
  auth.verifiedAccount.mockClear();
  vi.unstubAllGlobals();
});

describe("billing route authorization", () => {
  it("rejects unauthenticated billing status before database access", async () => {
    const env = routeEnv();
    const response = await worker.fetch(new Request("https://nibtool.com/billing/status"), env, {} as ExecutionContext);

    expect(response.status).toBe(401);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("ignores account selectors and binds billing status to the verified account", async () => {
    const env = routeEnv();
    auth.account = account("account-good");
    const response = await worker.fetch(
      new Request("https://nibtool.com/billing/status?account_id=account-evil"),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subscribed: true, plan: "high", hasBillingCustomer: true });
    expect(env.DB.binds).toEqual([["account-good"]]);
  });

  it("rejects unauthenticated plan changes before database or Stripe access", async () => {
    const env = routeEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request("https://nibtool.com/billing/plan", {
      method: "POST",
      body: JSON.stringify({ plan: "high" }),
    }), env, {} as ExecutionContext);

    expect(response.status).toBe(401);
    expect(env.DB.prepare).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function account(id: string): NibAccount {
  return { id, email: "person@example.test", sessionId: "session-1", sessionName: "test", platform: "web" };
}

function routeEnv(): Env & { DB: Env["DB"] & { prepare: ReturnType<typeof vi.fn>; binds: unknown[][] } } {
  const binds: unknown[][] = [];
  const prepare = vi.fn(() => ({
    bind: (...args: unknown[]) => {
      binds.push(args);
      return {
        first: async () => ({
          plan: "high",
          stripe_customer_id: "cus_nib",
          stripe_subscription_id: "sub_nib",
          stripe_recurring_item_id: "si_base",
        }),
      };
    },
  }));
  return {
    PUBLIC_ORIGIN: "https://nibtool.com",
    DB: { prepare, binds },
  } as unknown as Env & { DB: Env["DB"] & { prepare: ReturnType<typeof vi.fn>; binds: unknown[][] } };
}
