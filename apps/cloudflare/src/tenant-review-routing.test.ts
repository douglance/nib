import { describe, expect, it } from "vitest";
import {
  tenantReviewRoute,
  tenantScopedReviewApiResponse,
  tenantScopedReviewLink,
  tenantScopedReviewResponse,
} from "./tenant-review-routing";
import { reviewPageHtml } from "./review-page";

describe("tenant-scoped guest review routing", () => {
  it("makes service-binding review links portable to the public Worker", () => {
    expect(tenantScopedReviewLink("wsp_123", "/r/req_456#token=secret"))
      .toBe("/t/wsp_123/r/req_456#token=secret");
    expect(tenantReviewRoute("/t/wsp_123/r/req_456")).toEqual({
      kind: "page",
      tenantId: "wsp_123",
      requestId: "req_456",
      apiPrefix: "/t/wsp_123/v1",
    });
    expect(tenantReviewRoute("/t/wsp_123/v1/requests/req_456/session")).toEqual({
      kind: "api",
      tenantId: "wsp_123",
      apiPath: "/v1/requests/req_456/session",
      apiPrefix: "/t/wsp_123/v1",
    });
  });

  it("rewrites only JSON review links", async () => {
    const response = await tenantScopedReviewResponse(
      Response.json({ id: "req_456", reviewLink: "/r/req_456#token=secret" }, { status: 201 }),
      "wsp_123",
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "req_456",
      reviewLink: "/t/wsp_123/r/req_456#token=secret",
    });
  });

  it("scopes the review cookie and permits local HTTP acceptance tests", () => {
    const response = tenantScopedReviewApiResponse(
      new Response(null, {
        status: 204,
        headers: { "set-cookie": "nib_review=value; Path=/v1/requests/req_456; HttpOnly; Secure; SameSite=Strict" },
      }),
      "/t/wsp_123/v1",
      false,
    );
    expect(response.headers.get("set-cookie"))
      .toBe("nib_review=value; Path=/t/wsp_123/v1/requests/req_456; HttpOnly; SameSite=Strict");
  });

  it("renders tenant-scoped review API requests", () => {
    const html = reviewPageHtml("req_456", "https://nibtool.com", "/t/wsp_123/v1");
    expect(html).toContain('const apiPrefix = "/t/wsp_123/v1"');
    expect(html).toContain('apiPrefix + "/requests/" + encodeURIComponent(requestId)');
  });
});
