import { describe, expect, it } from "vitest";
import {
  isPrivatePage,
  isHostedNibRoute,
  isPublicAuthPage,
  isPublicDiscovery,
  isPublicMcpDiscoveryRequest,
  isPublicPage,
  isSiteAsset,
  publicReviewTenantId,
  withoutTrustedGuestContext,
} from "./routes";

describe("site routing", () => {
  it("serves Topcoat static assets publicly", () => {
    expect(
      isPublicPage("/assets/generated-ui-hero.png"),
    ).toBe(true);
    expect(isSiteAsset("/assets/generated-ui-hero.png")).toBe(true);
    expect(isSiteAsset("/docs")).toBe(false);
  });

  it("keeps the account page behind the authenticated route", () => {
    expect(isPublicPage("/account")).toBe(false);
    expect(isPrivatePage("/account")).toBe(true);
  });

  it("serves sign-in and device authorization before authentication", () => {
    expect(isPublicAuthPage("/signin")).toBe(true);
    expect(isPublicAuthPage("/device")).toBe(true);
    expect(isPublicAuthPage("/account")).toBe(false);
  });

  it("proxies hosted request APIs without proxying private billing or auth", () => {
    expect(isHostedNibRoute("/api/requests")).toBe(true);
    expect(isHostedNibRoute("/api/requests/req_123/respond")).toBe(true);
    expect(isHostedNibRoute("/api/devices")).toBe(true);
    expect(isHostedNibRoute("/billing/checkout")).toBe(false);
    expect(isHostedNibRoute("/api/auth/sign-out")).toBe(false);
    expect(isHostedNibRoute("/api/account")).toBe(false);
  });

  it("routes only tenant-scoped guest review pages and APIs publicly", () => {
    expect(publicReviewTenantId("/t/wsp_123/r/req_456")).toBe("wsp_123");
    expect(
      publicReviewTenantId("/t/wsp_123/v1/requests/req_456/session"),
    ).toBe("wsp_123");
    expect(
      publicReviewTenantId(
        "/t/wsp_123/attachments/35f219fd-f45c-41ea-a1cd-29e62edb4fa5",
      ),
    ).toBe("wsp_123");
    expect(publicReviewTenantId("/t/wsp_123/api/requests")).toBeUndefined();
    expect(publicReviewTenantId("/t/bad%2Ftenant/r/req_456")).toBeUndefined();
    expect(publicReviewTenantId("/r/req_456")).toBeUndefined();
  });

  it("preserves guest review credentials while removing trusted account context", () => {
    const routed = withoutTrustedGuestContext(
      new Request("https://nib.example.com/t/wsp_123/v1/requests/req_456", {
        headers: {
          authorization: "Bearer account-token",
          cookie:
            "better-auth.session_token=account-session; nib_review_session=session-token; analytics_id=visitor",
          "cf-access-jwt-assertion": "access-token",
          "x-nib-capability": "review-token",
          "x-nib-tenant": "spoofed-tenant",
          "x-nib-trial-network": "spoofed-network",
        },
      }),
    );

    expect(routed.headers.get("cookie")).toBe(
      "nib_review_session=session-token",
    );
    expect(routed.headers.get("x-nib-capability")).toBe("review-token");
    expect(routed.headers.has("authorization")).toBe(false);
    expect(routed.headers.has("cf-access-jwt-assertion")).toBe(false);
    expect(routed.headers.has("x-nib-tenant")).toBe(false);
    expect(routed.headers.has("x-nib-trial-network")).toBe(false);
  });

  it("does not classify MCP as a site route", () => {
    expect(isPublicPage("/mcp")).toBe(false);
    expect(isPrivatePage("/mcp")).toBe(false);
  });

  it("publishes agent discovery without publishing the generation transport", () => {
    expect(isPublicDiscovery("/openapi.json")).toBe(true);
    expect(isPublicDiscovery("/.well-known/skills/index.json")).toBe(true);
    expect(isPublicDiscovery("/.well-known/skills/generate/SKILL.md")).toBe(
      true,
    );
    expect(isPublicDiscovery("/mcp")).toBe(false);
    expect(isPublicDiscovery("/internal/v1/generate")).toBe(false);
  });

  it("allows unauthenticated MCP initialization and tool discovery", async () => {
    for (const method of [
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
    ]) {
      const request = new Request("https://nib.example.com/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
      });
      expect(await isPublicMcpDiscoveryRequest(request)).toBe(true);
    }
  });

  it("keeps MCP tool calls behind authentication", async () => {
    const toolCall = new Request("https://nib.example.com/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "generate_ui" },
      }),
    });
    expect(await isPublicMcpDiscoveryRequest(toolCall)).toBe(false);

    const mixedBatch = new Request("https://nib.example.com/mcp", {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "generate_ui" },
        },
      ]),
    });
    expect(await isPublicMcpDiscoveryRequest(mixedBatch)).toBe(false);
  });
});
