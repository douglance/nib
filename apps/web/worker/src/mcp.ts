import {
  McpServer,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { handleGeneration } from "./generation";
import type {
  Env,
  GenerationRequest,
  ImageFormat,
  Quality,
  ReferenceImage,
  Resolution,
} from "./types";

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
] as const;

const generateInput = {
  prompt: z
    .string()
    .max(4_000)
    .optional()
    .describe("The UI brief. Required unless resume is provided."),
  ref: z
    .array(z.string())
    .max(3)
    .optional()
    .describe(
      "Optional PNG, JPEG, or WebP reference images as base64 data URIs. Maximum three.",
    ),
  quality: z
    .enum(["fast", "standard", "pro"])
    .default("fast")
    .describe("Generation quality. Fast 1K is eligible for the free trial."),
  aspect: z
    .enum(ASPECTS)
    .default("16:9")
    .describe("Native Gemini aspect ratio."),
  resolution: z
    .enum(["1K", "2K", "4K"])
    .default("1K")
    .describe("Native Gemini output resolution."),
  format: z
    .enum(["png", "jpg"])
    .default("png")
    .describe("Returned image format."),
  background: z
    .boolean()
    .default(false)
    .describe("Queue the generation instead of waiting for its image."),
  resume: z
    .string()
    .optional()
    .describe("Resume or inspect a queued generation job."),
};

type GenerateArguments = {
  prompt?: string;
  ref?: string[];
  quality: Quality;
  aspect: (typeof ASPECTS)[number];
  resolution: Resolution;
  format: ImageFormat;
  background: boolean;
  resume?: string;
};

export function mcpResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const tenantId = request.headers.get("x-nib-tenant");
  const trialNetwork = request.headers.get("x-nib-trial-network");
  return createMcpHandler(() => createServer(env, tenantId, trialNetwork))(
    request,
    env,
    ctx,
  );
}

function createServer(
  env: Env,
  tenantId: string | null,
  trialNetwork: string | null,
): McpServer {
  const server = new McpServer(
    { name: "nib", version: "0.3.0" },
    {
      instructions:
        "Generate exactly one raw user-interface viewport image with the generate_ui tool.",
    },
  );

  server.registerTool(
    "generate_ui",
    {
      title: "Generate a UI image",
      description:
        "Generate one user-interface image from a text brief and optional references. Use when an AI agent can describe a UI but cannot create the image itself. Returns one PNG or JPEG image.",
      inputSchema: generateInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (arguments_: GenerateArguments) => {
      if (!tenantId) {
        return toolError(
          "AUTHENTICATION_REQUIRED",
          "Sign in before generating an image.",
        );
      }

      let references: ReferenceImage[];
      try {
        references = (arguments_.ref ?? []).map(parseReference);
      } catch (error) {
        return toolError(
          "INVALID_REFERENCE",
          error instanceof Error ? error.message : "Invalid reference image.",
        );
      }

      const input: GenerationRequest = {
        prompt: arguments_.prompt,
        resume_job_id: arguments_.resume,
        references,
        quality: arguments_.quality,
        aspect: arguments_.aspect,
        resolution: arguments_.resolution,
        format: arguments_.format,
        background: arguments_.background,
      };
      const headers = new Headers({
        "content-type": "application/json",
        "x-nib-tenant": tenantId,
      });
      if (trialNetwork) headers.set("x-nib-trial-network", trialNetwork);
      const response = await handleGeneration(
        new Request("https://worker.nib/internal/v1/generate", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        }),
        env,
      );
      const parsed: unknown = await response
        .json()
        .catch(() => ({ error: "GENERATION_FAILED" }));
      const result: Record<string, unknown> =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : { error: "GENERATION_FAILED" };
      if (!response.ok) {
        return toolError(
          String(result.error ?? "GENERATION_FAILED"),
          String(result.message ?? "Nib could not generate the UI image."),
        );
      }

      const content: CallToolResult["content"] = [
        {
          type: "text",
          text: JSON.stringify({ ...result, image: undefined }),
        },
      ];
      const image = result.image as
        | { data?: unknown; mime_type?: unknown }
        | null
        | undefined;
      if (
        image &&
        typeof image.data === "string" &&
        typeof image.mime_type === "string"
      ) {
        content.push({
          type: "image",
          data: image.data,
          mimeType: image.mime_type,
        });
      }
      return { content, structuredContent: result };
    },
  );

  return server;
}

function parseReference(value: string): ReferenceImage {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
    value,
  );
  if (!match) {
    throw new Error(
      "References must be PNG, JPEG, or WebP base64 data URIs.",
    );
  }
  return {
    name: "reference",
    mime_type: match[1]! as ReferenceImage["mime_type"],
    data: match[2]!,
  };
}

function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
    structuredContent: { error: code, message },
  };
}
