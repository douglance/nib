import { describe, expect, it } from "vitest";
import { searchDiscoveryResponse } from "./search-discovery";

const ORIGIN = "https://nib.example.com";

describe("search and agent discovery", () => {
  it("allows search and user-directed AI crawlers while keeping private routes out of the general crawl", async () => {
    const response = searchDiscoveryResponse("/robots.txt", ORIGIN);
    expect(response?.headers.get("content-type")).toContain("text/plain");
    const body = await response?.text();
    expect(body).toContain("User-agent: OAI-SearchBot\nAllow: /");
    expect(body).toContain("User-agent: Claude-SearchBot\nAllow: /");
    expect(body).toContain("Disallow: /internal/");
    expect(body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it("publishes only canonical public pages in the sitemap", async () => {
    const response = searchDiscoveryResponse("/sitemap.xml", ORIGIN);
    expect(response?.headers.get("content-type")).toContain("application/xml");
    const body = await response?.text();
    expect(body).toContain(`<loc>${ORIGIN}/docs</loc>`);
    expect(body).not.toContain("/account");
    expect(body).not.toContain("/mcp");
  });

  it("states the agent problem, tool contract, and public discovery links in llms.txt", async () => {
    const response = searchDiscoveryResponse("/llms.txt", ORIGIN);
    const body = await response?.text();
    expect(body).toContain("cannot create images");
    expect(body).toContain("MCP tool: `generate_ui`");
    expect(body).toContain(`${ORIGIN}/openapi.json`);
    expect(body).toContain(`${ORIGIN}/install-agent.md`);
  });

  it("publishes one canonical host-aware agent installer", async () => {
    const response = searchDiscoveryResponse("/install-agent.md", ORIGIN);
    expect(response?.headers.get("content-type")).toContain("text/markdown");
    const body = await response?.text();
    expect(body).toContain("codex mcp add nib --url");
    expect(body).toContain("claude mcp add --transport http --scope user");
    expect(body).toContain("gemini mcp add --transport http --scope user");
    expect(body).toContain("~/.codex/AGENTS.md");
    expect(body).toContain("~/.claude/CLAUDE.md");
    expect(body).toContain("~/.gemini/GEMINI.md");
    expect(body).toContain("Do not call `generate_ui` during installation");
  });

  it("publishes a remote MCP skill without a local binary requirement", async () => {
    const response = searchDiscoveryResponse(
      "/install/nib-ui-image/SKILL.md",
      ORIGIN,
    );
    expect(response?.headers.get("content-type")).toContain("text/markdown");
    const body = await response?.text();
    expect(body).toContain("name: nib-ui-image");
    expect(body).toContain("`generate_ui`");
    expect(body).not.toContain("requires_bin:");
  });

  it("does not claim unrelated paths", () => {
    expect(searchDiscoveryResponse("/docs", ORIGIN)).toBeUndefined();
  });
});
