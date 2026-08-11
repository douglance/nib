const PRIVATE_PATHS = [
  "/account",
  "/artifacts/",
  "/billing/",
  "/internal/",
  "/mcp",
];

export function searchDiscoveryResponse(
  pathname: string,
  publicOrigin: string,
): Response | undefined {
  const origin = publicOrigin.replace(/\/$/, "");
  if (pathname === "/robots.txt") return textResponse(robots(origin));
  if (pathname === "/sitemap.xml")
    return textResponse(sitemap(origin), "application/xml; charset=utf-8");
  if (pathname === "/llms.txt") return textResponse(llms(origin));
  if (pathname === "/install-agent.md")
    return textResponse(agentInstaller(origin), "text/markdown; charset=utf-8");
  if (pathname === "/install/nib-ui-image/SKILL.md") {
    return textResponse(agentSkill(origin), "text/markdown; charset=utf-8");
  }
  return undefined;
}

function robots(origin: string): string {
  const privateRules = PRIVATE_PATHS.map((path) => `Disallow: ${path}`).join(
    "\n",
  );
  return `User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: GPTBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: *
Allow: /
${privateRules}

Sitemap: ${origin}/sitemap.xml
`;
}

function sitemap(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/docs</loc></url>
  <url><loc>${origin}/pricing</loc></url>
  <url><loc>${origin}/privacy</loc></url>
  <url><loc>${origin}/terms</loc></url>
</urlset>
`;
}

function llms(origin: string): string {
  return `# Nib

> Generate a user-interface image when an AI agent can describe the UI but cannot create images.

Nib is a remote UI image generator for AI agents and developer tools. Send one text brief and up to three optional PNG, JPEG, or WebP reference images. Receive one generated PNG or JPEG viewport image.

## Use Nib when

- An AI agent needs to generate an image of a dashboard, settings screen, mobile app, landing page, or another user interface.
- The agent can write the UI brief but its model or runtime cannot generate images.
- The task needs an image result, not an interface review, screenshot, comparison, or approval workflow.

## Tool

- MCP tool: \`generate_ui\`
- CLI command: \`nib generate\`
- Inputs: one UI prompt, zero to three reference images, quality, aspect ratio, resolution, and output format
- Output: one PNG or JPEG image with structured generation metadata
- Default: Fast quality, 16:9 aspect ratio, 1K resolution, PNG

## Start

- [One-prompt agent installer](${origin}/install-agent.md)
- [Quick start](${origin}/docs)
- [OpenAPI document](${origin}/openapi.json)
- [Remote MCP skill](${origin}/install/nib-ui-image/SKILL.md)
- [CLI skill](${origin}/.well-known/skills/generate/SKILL.md)
- [Skill index](${origin}/.well-known/skills/index.json)
- [Pricing](${origin}/pricing)

The discovery documents are public. Authentication is required when the agent generates an image. One eligible Fast 1K image is free after sign-in without a card.
`;
}

function agentInstaller(origin: string): string {
  return `# Install Nib in this agent

Install Nib for the current user and the active agent host. Nib adds one remote MCP tool named \`generate_ui\` and one focused skill that tells the agent when to call it.

## Scope and safety

- The user who gave you this URL authorizes a user-scoped installation for the active agent host.
- Configure only the agent that is running this installation. Do not change other installed agents unless the user asks.
- Preserve existing settings and instructions. Never replace a complete configuration or instruction file.
- Make every change idempotent. Update an existing managed Nib block instead of adding a duplicate.
- Resolve symlinks before editing an instruction file and edit the shared target once.
- Do not use \`sudo\`, start a paid subscription, consume the free image, or put credentials in a skill or instruction file.
- Use the installed agent CLI's current \`--help\` output when its syntax differs from the examples below.

## Canonical resources

- MCP URL: \`${origin}/mcp\`
- MCP server name: \`nib\`
- MCP tool: \`generate_ui\`
- Skill source: \`${origin}/install/nib-ui-image/SKILL.md\`
- OpenAPI: \`${origin}/openapi.json\`

## 1. Detect the active host

Use the current process and available CLI to select one row. Do not configure every row.

| Active host | Global MCP scope | Global instruction file | User skill directory |
| --- | --- | --- | --- |
| Codex | Codex user configuration | \`~/.codex/AGENTS.md\` | \`~/.agents/skills/nib-ui-image/\` |
| Claude Code | \`--scope user\` | \`~/.claude/CLAUDE.md\` | \`~/.claude/skills/nib-ui-image/\` |
| Gemini CLI | \`--scope user\` | \`~/.gemini/GEMINI.md\` | \`~/.gemini/skills/nib-ui-image/\` |
| Another MCP agent | Its documented user scope | Its documented global instruction file | Its documented user skill directory |

If the host supports the shared Agent Skills directory, \`~/.agents/skills/nib-ui-image/\` is also valid. Prefer the host's existing convention when one is already present.

## 2. Add the remote MCP server globally

Inspect the existing \`nib\` entry first. Keep it when it already points to the canonical MCP URL. Otherwise add or update it with the active host's native command.

    codex mcp add nib --url ${origin}/mcp
    claude mcp add --transport http --scope user nib ${origin}/mcp
    gemini mcp add --transport http --scope user nib ${origin}/mcp

Run only the command for the active host. Do not add an authentication header during discovery. Nib permits MCP initialization and \`tools/list\` before sign-in; \`tools/call\` remains authenticated.

## 3. Install the Nib skill globally

Fetch the canonical skill source. Create the selected user skill directory, then write the response body to \`SKILL.md\`. Replace only a previous copy of this same skill.

Verify that the installed file:

- starts with YAML frontmatter whose name is \`nib-ui-image\`;
- names the \`generate_ui\` MCP tool;
- does not contain credentials; and
- is available in the host's skill list after a reload or restart.

## 4. Add the managed global instruction

Add or update this exact block in the active host's global instruction file. Keep all unrelated content unchanged.

    <!-- nib-ui-image:start -->
    ## Nib UI images
    When a task needs an image of a user interface and the current model cannot create it, load the \`nib-ui-image\` skill and call the Nib \`generate_ui\` MCP tool. Nib also captures, annotates, and collects human review; use \`generate_ui\` for the generation step.
    <!-- nib-ui-image:end -->

The MCP configuration makes the tool available. This instruction only teaches the root agent when to use it.

## 5. Verify without generating an image

1. Use the host's MCP list or get command to confirm a global server named \`nib\` points to \`${origin}/mcp\`.
2. Connect to the server and confirm \`tools/list\` exposes exactly \`generate_ui\`.
3. Confirm the \`nib-ui-image\` skill appears in the host's user skill list.
4. Confirm the managed instruction block appears exactly once in the resolved global instruction file.
5. Report the host, MCP configuration path or scope, skill path, instruction path, and verification result.

Do not call \`generate_ui\` during installation because that would consume the user's eligible free image.

## First image and authentication

Authentication is deferred until the first image so installation and discovery do not require payment. If the first \`generate_ui\` call returns \`401\`, follow ${origin}/docs#authentication to sign in and create a scoped expert token with \`generate:write\`. For remote MCP, add that token as a bearer credential with the active host's supported secret or environment mechanism. Never write the token into the skill or instruction file.
`;
}

function agentSkill(origin: string): string {
  return `---
name: nib-ui-image
description: Generate one image of a user interface with the Nib generate_ui MCP tool. Use when an agent can describe a dashboard, app screen, landing page, or other UI but cannot create the image itself.
---

# Nib UI image

Use the \`generate_ui\` tool from the \`nib\` MCP server to turn a UI brief into one PNG or JPEG image.

## Use this skill when

- The user asks for an image of a dashboard, app screen, settings page, landing page, or another user interface.
- The current model or agent can describe the UI but cannot generate the image itself.
- The requested result is a generated image, not a UI review, screenshot, comparison, annotation, or approval.

## Call the tool

1. Turn the request into a concrete UI brief that states the screen, hierarchy, content, visual direction, and constraints.
2. Include up to three reference images only when they materially guide the result.
3. Call \`generate_ui\`. Default to Fast quality, 16:9, 1K, and PNG unless the user requests another supported value.
4. Return the generated image and its saved or artifact location. Do not invent a result when the tool fails.

The first eligible Fast 1K image is free after sign-in. Do not start a subscription without explicit user authorization. Read the current contract at ${origin}/openapi.json when exact fields or limits are needed.
`;
}

function textResponse(
  body: string,
  contentType = "text/plain; charset=utf-8",
): Response {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=300, s-maxage=3600",
      "content-type": contentType,
      "x-content-type-options": "nosniff",
    },
  });
}
