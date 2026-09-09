import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

import worker from "./index";
import type { Env } from "./types";

describe("site CSP", () => {
  it("allows only Nib and the required Stripe form redirect origins", async () => {
    const response = await worker.fetch(new Request("https://nibtool.com/pricing"), {
      PUBLIC_ORIGIN: "https://nibtool.com",
      SITE: { fetch: async () => new Response("<form method='post' action='/billing/checkout'></form>") },
      ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    } as unknown as Env, {} as ExecutionContext);

    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self' https://checkout.stripe.com https://billing.stripe.com");
    expect(csp).not.toMatch(/form-action 'self';/);
  });
});
