#!/usr/bin/env node

const endpoint = process.env.NIB_MCP_URL ?? "http://127.0.0.1:8790/mcp";
const tenant = process.env.NIB_DEV_TENANT ?? "dogfood@nib.local";
const resumeJob = process.argv[2] ?? process.env.NIB_RESUME_JOB;
let sessionId;

function decodeResponse(body, contentType) {
  if (!contentType.includes("text/event-stream")) {
    return JSON.parse(body);
  }

  const payload = body
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trim();
  if (!payload) {
    throw new Error("MCP response did not contain an SSE data event");
  }
  return JSON.parse(payload);
}

async function rpc(id, method, params) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "x-nib-dev-tenant": tenant,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
  });
  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${response.status}: ${await response.text()}`);
  }
  sessionId ??= response.headers.get("mcp-session-id") ?? undefined;
  const message = decodeResponse(await response.text(), response.headers.get("content-type") ?? "");
  if (message.error) {
    throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
  }
  return message.result;
}

async function notify(method) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "x-nib-dev-tenant": tenant,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method }),
  });
  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${response.status}: ${await response.text()}`);
  }
}

const initialized = await rpc(1, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "nib-dogfood", version: "1.0.0" },
});
await notify("notifications/initialized");

const listed = await rpc(2, "tools/list");
const toolNames = listed.tools.map((tool) => tool.name);
if (toolNames.length !== 1 || toolNames[0] !== "generate_ui") {
  throw new Error(`expected only generate_ui, received ${toolNames.join(", ") || "no tools"}`);
}

let resumed;
if (resumeJob) {
  resumed = await rpc(3, "tools/call", {
    name: "generate_ui",
    arguments: { resume: resumeJob },
  });
  if (resumed.isError) {
    throw new Error(
      `generate_ui resume returned isError=true: ${JSON.stringify({
        content: resumed.content,
        structuredContent: resumed.structuredContent,
      })}`,
    );
  }
  const image = resumed.content?.find((item) => item.type === "image");
  if (!image?.data || !image.mimeType?.startsWith("image/")) {
    throw new Error("generate_ui resume did not return an MCP image content block");
  }
  if (resumed.structuredContent?.job_id !== resumeJob) {
    throw new Error("generate_ui resume returned the wrong job");
  }
}

console.log(
  JSON.stringify(
    {
      endpoint,
      server: initialized.serverInfo,
      protocolVersion: initialized.protocolVersion,
      tools: toolNames,
      ...(resumed
        ? {
            resumed: {
              jobId: resumed.structuredContent.job_id,
              status: resumed.structuredContent.status,
              contentTypes: resumed.content.map((item) => item.type),
            },
          }
        : {}),
    },
    null,
    2,
  ),
);
