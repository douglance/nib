import { describe, expect, it } from "vitest";
import {
  isPrivatePage,
  isPublicDiscovery,
  isPublicMcpDiscoveryRequest,
  isPublicPage,
  isPublicReviewCapabilityRoute,
  isSiteAsset,
  legacyReviewInterfaceRedirect,
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

  it("publishes support without exposing account management", () => {
    expect(isPublicPage("/support")).toBe(true);
    expect(isPrivatePage("/support")).toBe(false);
    expect(isPublicPage("/account/delete")).toBe(false);
    expect(isPrivatePage("/account/delete")).toBe(true);
  });

  it("does not classify MCP as a site route", () => {
    expect(isPublicPage("/mcp")).toBe(false);
    expect(isPrivatePage("/mcp")).toBe(false);
  });

  it("routes account-scoped review capabilities to the web interface", () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    const requestId = "22222222-2222-4222-8222-222222222222";
    const base = `/r/${accountId}/${requestId}`;

    expect(isPublicReviewCapabilityRoute(base)).toBe(true);
    expect(isPublicReviewCapabilityRoute(`${base}/data`)).toBe(true);
    expect(isPublicReviewCapabilityRoute(`${base}/respond`)).toBe(true);
    expect(isPublicReviewCapabilityRoute(`${base}/attachments/${requestId}`)).toBe(true);
    expect(isPublicReviewCapabilityRoute(`/r/${requestId}`)).toBe(false);
    expect(isPublicReviewCapabilityRoute(`/r/not-an-account/${requestId}`)).toBe(false);
  });

  it("canonicalizes legacy review links into the web interface", () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    const requestId = "22222222-2222-4222-8222-222222222222";
    const response = legacyReviewInterfaceRedirect(
      new URL(`https://nibtool.com/r/${requestId}`),
      accountId,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://nibtool.com/r/${accountId}/${requestId}`,
    );
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
