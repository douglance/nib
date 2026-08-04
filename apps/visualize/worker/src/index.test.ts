import { describe, expect, it } from "vitest";
import {
  isPrivatePage,
  isPublicDiscovery,
  isPublicMcpDiscoveryRequest,
  isPublicPage,
  isSiteAsset,
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
      const request = new Request("https://visualize.example.com/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
      });
      expect(await isPublicMcpDiscoveryRequest(request)).toBe(true);
    }
  });

  it("keeps MCP tool calls behind authentication", async () => {
    const toolCall = new Request("https://visualize.example.com/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "generate_ui" },
      }),
    });
    expect(await isPublicMcpDiscoveryRequest(toolCall)).toBe(false);

    const mixedBatch = new Request("https://visualize.example.com/mcp", {
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
