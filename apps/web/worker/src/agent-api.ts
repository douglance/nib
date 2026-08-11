const ASPECTS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

export function agentApiResponse(
  pathname: string,
  publicOrigin: string,
): Response | undefined {
  const origin = publicOrigin.replace(/\/$/, "");
  if (pathname === "/openapi.json") return Response.json(openApi(origin));
  if (pathname === "/.well-known/skills/index.json") {
    return Response.json({
      skills: [
        {
          name: "generate",
          description:
            "Generate one image of a user interface from a text brief and optional references.",
          url: `${origin}/.well-known/skills/generate/SKILL.md`,
        },
      ],
    });
  }
  if (pathname === "/.well-known/skills/generate/SKILL.md") {
    return new Response(generateSkill(origin), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
  return undefined;
}

function openApi(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Nib UI image generator",
      version: "0.1.0",
      description:
        "Generate exactly one user-interface viewport image from a text brief and optional references.",
    },
    servers: [{ url: origin }],
    paths: {
      "/internal/v1/generate": {
        post: {
          operationId: "generateUi",
          summary: "Generate one UI image",
          description:
            "Returns one PNG or JPEG image inline with generation metadata, or a queued job when background is true.",
          security: [{ expertToken: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GenerationRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Generated image or queued generation job.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GenerationResponse" },
                },
              },
            },
            "401": { description: "Authentication required." },
            "402": { description: "Trial unavailable or subscription required." },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        expertToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "nib_pat",
          description: "A scoped Nib expert token with generate:write.",
        },
      },
      schemas: {
        ReferenceImage: {
          type: "object",
          additionalProperties: false,
          required: ["name", "mime_type", "data"],
          properties: {
            name: { type: "string" },
            mime_type: {
              type: "string",
              enum: ["image/png", "image/jpeg", "image/webp"],
            },
            data: { type: "string", contentEncoding: "base64" },
          },
        },
        GenerationRequest: {
          type: "object",
          additionalProperties: false,
          required: [
            "references",
            "quality",
            "aspect",
            "resolution",
            "format",
            "background",
          ],
          properties: {
            prompt: { type: "string", maxLength: 4_000 },
            resume_job_id: { type: "string", format: "uuid" },
            references: {
              type: "array",
              maxItems: 3,
              items: { $ref: "#/components/schemas/ReferenceImage" },
            },
            quality: {
              type: "string",
              enum: ["fast", "standard", "pro"],
              default: "fast",
            },
            aspect: { type: "string", enum: ASPECTS, default: "16:9" },
            resolution: {
              type: "string",
              enum: ["1K", "2K", "4K"],
              default: "1K",
            },
            format: {
              type: "string",
              enum: ["png", "jpg"],
              default: "png",
            },
            background: { type: "boolean", default: false },
          },
        },
        GenerationResponse: {
          type: "object",
          required: ["job_id", "status"],
          properties: {
            job_id: { type: "string" },
            status: { type: "string" },
            artifact_url: { type: ["string", "null"] },
            image: {
              anyOf: [
                {
                  type: "object",
                  required: ["data", "mime_type"],
                  properties: {
                    data: { type: "string", contentEncoding: "base64" },
                    mime_type: { type: "string" },
                  },
                },
                { type: "null" },
              ],
            },
          },
        },
      },
    },
  };
}

function generateSkill(origin: string): string {
  return `---
name: generate
description: Generate one image of a user interface when an agent can describe the UI but cannot create the image itself.
---

# Generate a UI image

Use Nib only when the task requires a generated image of a dashboard, app screen, landing page, settings view, or another user interface.

## Interfaces

- Remote MCP: \`${origin}/mcp\`
- MCP tool: \`generate_ui\`
- HTTP: \`POST ${origin}/internal/v1/generate\`
- OpenAPI: \`${origin}/openapi.json\`

## Method

1. Write a precise visual brief covering the viewport, content, hierarchy, layout, visual style, and constraints.
2. Add up to three PNG, JPEG, or WebP references only when they materially guide the result.
3. Call \`generate_ui\`. Default to Fast, 16:9, 1K, and PNG unless the user asks for another supported value.
4. Return the generated image directly to the user.

Do not use Nib for interface review, scoring, annotation, comparison, or screenshot capture. The first eligible Fast 1K image is free after sign-in. Never start a subscription without explicit user authorization.
`;
}
