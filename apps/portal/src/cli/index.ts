import { Cli, z } from "incur";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { checkNormalizedHtml, diffHtmlFiles, summarizeHtmlFile } from "../html/analysis";
import { buildHtmlContextBundle, scanDesignSystem } from "../html/contextBundles";
import { notifyWaitingOnce, scanOnce as scanWaitingOnce, startWatch } from "../server/waiting/watcher";
import type {
  CommandRequest,
  DeviceRecord,
  FeedbackRequest,
  FeedbackResponseMode,
  FeedbackStatus,
  HtmlArtifactSummary,
  ProjectInfo,
  RegisteredTarget,
  RequestRecord
} from "../shared/types";
import type { Frame, Locator, Page } from "playwright";

const execFileAsync = promisify(execFile);

const env = z.object({
  PRTL_BASE_URL: z.string().default("https://doug-mm.tail5d92b4.ts.net")
});

const requestStatusOutput = z.enum(["open", "viewed", "answered", "acted", "stale", "resolved", "expired"]);

const requestSummaryOutput = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  prompt: z.string(),
  status: requestStatusOutput,
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  choices: z.array(z.string()),
  responses: z.number(),
  attachments: z.number(),
  updatedAt: z.string(),
  viewerUrl: z.string()
});

const requestRecordOutput = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  prompt: z.string(),
  body: z.string().nullable(),
  context: z.string().nullable(),
  choices: z.array(z.string()),
  allowText: z.boolean(),
  target: z.unknown(),
  status: requestStatusOutput,
  priority: z.string(),
  source: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  viewedAt: z.string().nullable(),
  answeredAt: z.string().nullable(),
  actedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  notifiedAt: z.string().nullable(),
  notificationClickedAt: z.string().nullable(),
  staleReason: z.string().nullable(),
  attachments: z.array(z.unknown()),
  responses: z.array(z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  viewerUrl: z.string()
});

const requestWaitOutput = z.union([
  requestRecordOutput,
  z.object({
    timeout: z.literal(true),
    requestId: z.string()
  })
]);

export const cli = Cli.create("prtl", {
  version: "0.1.0",
  description: "Operate the prtl interaction chrome for websites and HTML artifacts.",
  env,
  mcpServer: {
    cache: { ttlMs: 300000, cacheScope: "private" }
  },
  sync: {
    depth: 1,
    suggestions: [
      "list active portal projects",
      "run a command in a project through prtl",
      "inspect portal health and recent activity"
    ]
  },
  mcp: {
    command: "prtl --mcp"
  }
});

const project = Cli.create("project", { description: "Project discovery and viewer commands", env });
project.command("list", {
  description: "List active projects with route and compatibility status.",
  run: async ({ env }) => {
    const data = await apiGet<{ projects: ProjectInfo[] }>(portalBaseUrl(), "/api/projects");
    return {
      projects: data.projects.map((item) => ({
        id: item.id,
        name: item.name,
        targetKind: item.targetKind,
        port: item.port,
        preferredRoute: item.preferredRoute,
        direct: item.routes.direct?.available ?? false,
        proxy: item.routes.pathProxy?.available ?? false,
        compatibility: item.compatibility.level,
        viewerUrl: `${portalBaseUrl()}/view/${item.id}`
      }))
    };
  }
});
project.command("view", {
  description: "Return the viewer URL for a project.",
  args: z.object({
    project: z.string().describe("Project id, name, or port")
  }),
  run: async ({ args, env }) => {
    const item = await resolveProject(portalBaseUrl(), args.project);
    return {
      id: item.id,
      name: item.name,
      url: `${portalBaseUrl()}/view/${item.id}`
    };
  }
});
project.command("recheck", {
  description: "Refresh discovery and compatibility for a project.",
  args: z.object({
    project: z.string().describe("Project id, name, or port")
  }),
  run: async ({ args, env }) => {
    const item = await resolveProject(portalBaseUrl(), args.project);
    return apiPost(portalBaseUrl(), `/api/projects/${encodeURIComponent(item.id)}/recheck`, {});
  }
});

const feedback = Cli.create("feedback", { description: "Precise product feedback requests for the current user-visible view", env });
feedback.command("ask", {
  description: "Ask a human-level product question about the exact app view and return a phone-ready viewer URL.",
  args: z.object({
    project: z.string().describe("Project id, name, or port")
  }),
  options: z.object({
    path: z.string().default("/").describe("App path to open in the project"),
    prompt: z.string().describe("Human product-feedback question about what the user sees"),
    context: z.string().optional().describe("Product context, acceptance criteria, or what to inspect"),
    responseMode: z.string().default("mixed").describe("Expected human response style, arbitrary agent-defined value allowed"),
    responseSpec: z.string().optional().describe("JSON object describing requested feedback format, rubric, scale, or fields"),
    option: z.array(z.string()).default([]).describe("Choice option. Repeat for multiple choices."),
    metadata: z.string().optional().describe("JSON metadata for agent correlation and precision")
  }),
  run: async ({ args, options, env }) => {
    const item = await resolveProject(portalBaseUrl(), args.project);
    const request = await apiPost<FeedbackRequest>(portalBaseUrl(), "/api/feedback", {
      projectId: item.id,
      prompt: options.prompt,
      appPath: options.path,
      context: options.context,
      responseMode: options.responseMode,
      responseSpec: parseOptionalObject(options.responseSpec, "--response-spec", undefined),
      choices: options.option,
      metadata: parseOptionalObject(options.metadata, "--metadata")
    });
    return withFeedbackUrl(request);
  }
});
feedback.command("request", {
  description: "Create a fully specified product feedback request for an exact app view.",
  args: z.object({
    project: z.string().optional().describe("Project id, name, port, or registered target id")
  }),
  options: z.object({
    path: z.string().default("/").describe("App path to open in the project"),
    url: z.string().optional().describe("Register this website URL as a feedback target before asking"),
    html: z.string().optional().describe("Validate and register this local HTML file as a feedback target before asking"),
    name: z.string().optional().describe("Name for a URL or HTML target registered by this request"),
    artifactKind: z.string().optional().describe("Optional artifact kind for --html targets"),
    surfaceHtml: z.string().optional().describe("Local HTML file to use as the prtl chrome feedback surface"),
    surfaceTitle: z.string().optional().describe("Optional title for the feedback surface"),
    prompt: z.string().describe("Precise human-level product question, not a code question"),
    context: z.string().optional().describe("Product subject matter, hypothesis, or acceptance criteria"),
    responseMode: z.string().default("mixed").describe("Expected human response style, arbitrary agent-defined value allowed"),
    responseSpec: z.string().optional().describe("JSON object describing requested feedback format, rubric, scale, or fields"),
    option: z.array(z.string()).default([]).describe("Choice option. Repeat for multiple choices."),
    metadata: z.string().optional().describe("JSON object for agent state, intent, artifact ids, or correlation keys")
  }),
  run: async ({ args, options, env }) => {
    const item = await resolveFeedbackTarget(args.project, options);
    const request = await apiPost<FeedbackRequest>(portalBaseUrl(), "/api/feedback", {
      projectId: item.id,
      prompt: options.prompt,
      appPath: options.path,
      context: options.context,
      responseMode: options.responseMode,
      responseSpec: parseOptionalObject(options.responseSpec, "--response-spec", undefined),
      choices: options.option,
      feedbackSurfaceHtml: options.surfaceHtml ? await fs.readFile(options.surfaceHtml, "utf8") : undefined,
      feedbackSurfaceTitle: options.surfaceTitle,
      metadata: {
        ...parseOptionalObject(options.metadata, "--metadata"),
        targetKind: item.targetKind
      }
    });
    return withFeedbackUrl(request);
  }
});
feedback.command("choice", {
  description: "Ask a product feedback question with fixed human choices.",
  args: z.object({
    project: z.string().describe("Project id, name, or port")
  }),
  options: z.object({
    path: z.string().default("/").describe("App path to open in the project"),
    prompt: z.string().describe("Human product-feedback question about what the user sees"),
    option: z.array(z.string()).default([]).describe("Choice option. Repeat for multiple choices."),
    context: z.string().optional().describe("Additional context shown with the request"),
    responseSpec: z.string().optional().describe("JSON object describing requested feedback format, rubric, scale, or fields"),
    metadata: z.string().optional().describe("JSON metadata for agent correlation and precision")
  }),
  run: async ({ args, options, env }) => {
    const item = await resolveProject(portalBaseUrl(), args.project);
    const request = await apiPost<FeedbackRequest>(portalBaseUrl(), "/api/feedback", {
      projectId: item.id,
      prompt: options.prompt,
      appPath: options.path,
      choices: options.option,
      context: options.context,
      responseMode: "choice" satisfies FeedbackResponseMode,
      responseSpec: parseOptionalObject(options.responseSpec, "--response-spec", undefined),
      metadata: parseOptionalObject(options.metadata, "--metadata")
    });
    return withFeedbackUrl(request);
  }
});
feedback.command("list", {
  description: "List feedback requests.",
  options: z.object({
    project: z.string().optional().describe("Optional project id, name, or port"),
    includeMissing: z.boolean().default(false).describe("Include requests whose project is no longer active")
  }),
  run: async ({ options, env }) => {
    const item = options.project ? await resolveProject(portalBaseUrl(), options.project) : null;
    const params = new URLSearchParams();
    if (item) params.set("projectId", item.id);
    if (options.includeMissing) params.set("includeMissing", "1");
    const suffix = params.size ? `?${params.toString()}` : "";
    return { feedback: (await apiGet<FeedbackRequest[]>(portalBaseUrl(), `/api/feedback${suffix}`)).map(summarizeFeedback) };
  }
});
feedback.command("metrics", {
  description: "Show feedback-loop speed metrics.",
  run: async ({ env }) => apiGet(portalBaseUrl(), "/api/feedback/metrics")
});
feedback.command("test-notification", {
  description: "Send a test desktop/mobile notification to subscribed devices.",
  run: async ({ env }) => apiPost(portalBaseUrl(), "/api/notifications/test", {})
});
feedback.command("show", {
  description: "Show one feedback request with human responses and hidden anchoring metadata.",
  args: z.object({
    requestId: z.string().describe("Feedback request id")
  }),
  run: async ({ args, env }) => withFeedbackUrl(await apiGet<FeedbackRequest>(portalBaseUrl(), `/api/feedback/${args.requestId}`))
});
feedback.command("wait", {
  description: "Wait until feedback is answered, resolved, or stale.",
  args: z.object({
    requestId: z.string().describe("Feedback request id")
  }),
  options: z.object({
    timeout: z.coerce.number().default(300000).describe("Timeout in milliseconds")
  }),
  run: async ({ args, options, env }) => {
    const started = Date.now();
    while (Date.now() - started < options.timeout) {
      const request = await apiGet<FeedbackRequest>(portalBaseUrl(), `/api/feedback/${args.requestId}`);
      if (["answered", "resolved", "stale"].includes(request.status)) return withFeedbackUrl(request);
      await sleep(1500);
    }
    return { timeout: true, requestId: args.requestId };
  }
});
feedback.command("resolve", {
  description: "Mark feedback as resolved.",
  args: z.object({
    requestId: z.string().describe("Feedback request id")
  }),
  run: async ({ args, env }) =>
    withFeedbackUrl(await apiPatch<FeedbackRequest>(portalBaseUrl(), `/api/feedback/${args.requestId}`, { status: "resolved" }))
});
feedback.command("stale", {
  description: "Mark feedback as stale.",
  args: z.object({
    requestId: z.string().describe("Feedback request id")
  }),
  run: async ({ args, env }) =>
    withFeedbackUrl(await apiPatch<FeedbackRequest>(portalBaseUrl(), `/api/feedback/${args.requestId}`, { status: "stale" }))
});
feedback.command("edits", {
  description: "Show tracked page edits for one feedback request.",
  args: z.object({
    requestId: z.string().describe("Feedback request id")
  }),
  run: async ({ args, env }) => {
    const request = await apiGet<FeedbackRequest>(portalBaseUrl(), `/api/feedback/${args.requestId}`);
    return {
      requestId: request.id,
      projectId: request.projectId,
      projectName: request.projectName,
      isStale: request.isStale,
      staleReason: request.staleReason,
      edits: request.edits.map((edit) => ({
        id: edit.id,
        targetId: edit.targetId,
        selector: edit.selector,
        tagName: edit.tagName,
        before: edit.before,
        after: edit.after,
        createdAt: edit.createdAt
      }))
    };
  }
});
feedback.command("export", {
  description: "Export feedback responses, structured data, screenshots, and edits as prompt, markdown, or JSON.",
  args: z.object({
    requestId: z.string().describe("Feedback request id")
  }),
  options: z.object({
    exportFormat: z.enum(["prompt", "markdown", "json"]).default("prompt").describe("Feedback export format")
  }),
  run: async ({ args, options, env }) => {
    const request = await apiGet<FeedbackRequest>(portalBaseUrl(), `/api/feedback/${args.requestId}`);
    if (options.exportFormat === "json") return request;
    const text = formatFeedbackExport(request, options.exportFormat);
    return { requestId: request.id, exportFormat: options.exportFormat, text };
  }
});

const request = Cli.create("request", { description: "Unified human request, approval, and unstick workflows", env });
request.command("create", {
  description: "Create a unified request for human input.",
  mcpTool: {
    title: "Create human request",
    annotations: { openWorldHint: true, idempotentHint: false }
  },
  options: z.object({
    kind: z.string().default("question").describe("Request kind: approval, choice, question, review, notification, tmux"),
    title: z.string().optional().describe("Short notification title"),
    prompt: z.string().describe("Human-facing request prompt"),
    body: z.string().optional().describe("Optional notification body"),
    context: z.string().optional().describe("Extra context for the request detail view"),
    project: z.string().optional().describe("Optional project id, name, or port"),
    path: z.string().default("/").describe("Project app path"),
    url: z.string().optional().describe("Optional URL to open"),
    option: z.array(z.string()).default([]).describe("Choice option. Repeat for multiple choices."),
    text: z.boolean().default(true).describe("Allow freeform text response"),
    wait: z.boolean().default(false).describe("Wait for an answer before returning"),
    timeout: z.coerce.number().default(300000).describe("Wait timeout in milliseconds"),
    metadata: z.string().optional().describe("JSON metadata for correlation")
  }),
  output: requestWaitOutput,
  run: async ({ options, env }) => {
    const item = options.project ? await resolveProject(portalBaseUrl(), options.project) : null;
    const created = await apiPost<RequestRecord>(portalBaseUrl(), "/api/requests", {
      kind: options.kind,
      title: options.title,
      prompt: options.prompt,
      body: options.body,
      context: options.context,
      projectId: item?.id,
      appPath: options.path,
      url: options.url,
      choices: options.option,
      allowText: options.text,
      metadata: parseOptionalObject(options.metadata, "--metadata")
    });
    return options.wait ? waitForRequest(created.id, options.timeout) : withRequestUrl(created);
  }
});
request.command("list", {
  description: "List unified requests.",
  mcpTool: {
    title: "List human requests",
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  options: z.object({
    project: z.string().optional().describe("Optional project id, name, or port")
  }),
  output: z.object({ requests: z.array(requestSummaryOutput) }),
  run: async ({ options, env }) => {
    const item = options.project ? await resolveProject(portalBaseUrl(), options.project) : null;
    const suffix = item ? `?projectId=${encodeURIComponent(item.id)}` : "";
    return { requests: (await apiGet<RequestRecord[]>(portalBaseUrl(), `/api/requests${suffix}`)).map(summarizeRequest) };
  }
});
request.command("show", {
  description: "Show one unified request.",
  mcpTool: {
    title: "Show human request",
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  args: z.object({
    requestId: z.string().describe("Request id")
  }),
  output: requestRecordOutput,
  run: async ({ args, env }) => withRequestUrl(await apiGet<RequestRecord>(portalBaseUrl(), `/api/requests/${args.requestId}`))
});
request.command("respond", {
  description: "Respond to one unified request.",
  mcpTool: {
    title: "Respond to human request",
    annotations: { openWorldHint: true, idempotentHint: false }
  },
  args: z.object({
    requestId: z.string().describe("Request id")
  }),
  options: z.object({
    text: z.string().optional().describe("Freeform text response"),
    choice: z.string().optional().describe("Choice label"),
    choiceIndex: z.coerce.number().optional().describe("Zero-based choice index"),
    kind: z.string().optional().describe("Response kind"),
    data: z.string().optional().describe("JSON object response data")
  }),
  output: requestRecordOutput,
  run: async ({ args, options, env }) =>
    withRequestUrl(await apiPost<RequestRecord>(portalBaseUrl(), `/api/requests/${args.requestId}/respond`, {
      text: options.text,
      choice: options.choice,
      choiceIndex: options.choiceIndex,
      kind: options.kind,
      data: parseOptionalObject(options.data, "--data", undefined)
    }))
});
request.command("wait", {
  description: "Wait until a unified request is answered, acted, resolved, stale, or expired.",
  mcpTool: {
    title: "Wait for human response",
    annotations: { readOnlyHint: true, openWorldHint: true },
    task: { required: true, ttlMs: 900000, pollIntervalMs: 1500 }
  },
  args: z.object({
    requestId: z.string().describe("Request id")
  }),
  options: z.object({
    timeout: z.coerce.number().default(300000).describe("Timeout in milliseconds")
  }),
  output: requestWaitOutput,
  run: async ({ args, options, env }) => waitForRequest(args.requestId, options.timeout)
});

cli.command("ask", {
  description: "Ask for human input through the unified prtl request system.",
  mcpTool: {
    title: "Ask human",
    annotations: { openWorldHint: true, idempotentHint: false }
  },
  options: z.object({
    prompt: z.string().describe("Human-facing prompt"),
    title: z.string().optional().describe("Short notification title"),
    option: z.array(z.string()).default([]).describe("Choice option. Repeat for multiple choices."),
    text: z.boolean().default(true).describe("Allow text response"),
    project: z.string().optional().describe("Optional project id, name, or port"),
    path: z.string().default("/").describe("Project app path"),
    url: z.string().optional().describe("Optional URL to open"),
    wait: z.boolean().default(false).describe("Wait for an answer"),
    timeout: z.coerce.number().default(300000).describe("Wait timeout in milliseconds")
  }),
  output: requestWaitOutput,
  run: async ({ options, env }) => {
    const item = options.project ? await resolveProject(portalBaseUrl(), options.project) : null;
    const created = await apiPost<RequestRecord>(portalBaseUrl(), "/api/requests", {
      kind: options.option.length ? "choice" : "question",
      title: options.title,
      prompt: options.prompt,
      choices: options.option,
      allowText: options.text,
      projectId: item?.id,
      appPath: options.path,
      url: options.url,
      source: "cli"
    });
    return options.wait ? waitForRequest(created.id, options.timeout) : withRequestUrl(created);
  }
});

cli.command("notify", {
  description: "Send a quick prtl notification through the unified request system.",
  options: z.object({
    title: z.string().describe("Notification title"),
    body: z.string().describe("Notification body"),
    url: z.string().optional().describe("URL to open")
  }),
  run: async ({ options, env }) => apiPost(portalBaseUrl(), "/api/notify", options)
});

const device = Cli.create("device", { description: "Registered prtl devices and notification endpoints", env });
device.command("list", {
  description: "List registered devices.",
  run: async ({ env }) => apiGet<{ devices: DeviceRecord[] }>(portalBaseUrl(), "/api/devices")
});
device.command("register", {
  description: "Register an APNs device token.",
  options: z.object({
    token: z.string().describe("APNs device token"),
    name: z.string().default("iPhone").describe("Device name"),
    platform: z.string().default("ios").describe("ios, watchos, macos, web, or unknown")
  }),
  run: async ({ options, env }) => apiPost<DeviceRecord>(portalBaseUrl(), "/api/devices", {
    token: options.token,
    name: options.name,
    platform: options.platform,
    pushKind: "apns",
    capabilities: ["alert", "actions", "text", "open"]
  })
});
device.command("apns-probe", {
  description: "Send a native-only APNs probe to registered iOS/watchOS devices.",
  run: async ({ env }) => apiPost(portalBaseUrl(), "/api/notifications/apns/probe", {})
});

cli.command("watch", {
  description: "Watch tmux panes for blocked prompts and create unified requests.",
  options: z.object({
    session: z.string().default("0").describe("tmux session to watch"),
    interval: z.coerce.number().default(20000).describe("Polling interval in milliseconds"),
    once: z.boolean().default(false).describe("Scan once and exit"),
    json: z.boolean().default(false).describe("With --once, print waiting panes without notifying"),
    actuate: z.boolean().default(false).describe("Mark requests as safe for tmux actuation after fingerprint verification")
  }),
  run: async ({ options, env }) => {
    if (options.once && (options.json || process.argv.includes("--json"))) return { waiting: await scanWaitingOnce(options.session) };
    if (options.once) return notifyWaitingOnce(options.session);
    await startWatch({ session: options.session, intervalMs: options.interval, actuate: options.actuate });
  }
});

const command = Cli.create("command", { description: "Run shell commands through the portal", env });
command.command("run", {
  description: "Run a shell command in a project directory.",
  args: z.object({
    project: z.string().describe("Project id, name, or port"),
    command: z.string().describe("Shell command to run")
  }),
  options: z.object({
    cwd: z.string().optional().describe("Override working directory")
  }),
  examples: [
    { args: { project: "localpr", command: "pwd" }, description: "Print the project working directory" },
    { args: { project: "4392", command: "npm run typecheck" }, description: "Run a package script by port" }
  ],
  run: async ({ args, options, env }) => {
    const item = await resolveProject(portalBaseUrl(), args.project);
    const request: CommandRequest = { command: args.command, cwd: options.cwd };
    return apiPost(portalBaseUrl(), `/api/projects/${encodeURIComponent(item.id)}/commands`, request);
  }
});
command.command("history", {
  description: "List command history for a project.",
  args: z.object({
    project: z.string().describe("Project id, name, or port")
  }),
  run: async ({ args, env }) => {
    const item = await resolveProject(portalBaseUrl(), args.project);
    return { commands: await apiGet(portalBaseUrl(), `/api/projects/${encodeURIComponent(item.id)}/commands`) };
  }
});

const screenshot = Cli.create("screenshot", { description: "Screenshot commands", env });
screenshot.command("capture", {
  description: "Capture phone, tablet, and desktop screenshots for a project.",
  args: z.object({
    project: z.string().describe("Project id, name, or port")
  }),
  run: async ({ args, env }) => {
    const item = await resolveProject(portalBaseUrl(), args.project);
    return apiPost(portalBaseUrl(), `/api/projects/${encodeURIComponent(item.id)}/screenshots`, {});
  }
});

const activity = Cli.create("activity", { description: "Activity feed commands", env });
activity.command("list", {
  description: "List recent portal activity.",
  options: z.object({
    project: z.string().optional().describe("Optional project id, name, or port")
  }),
  run: async ({ options, env }) => {
    const item = options.project ? await resolveProject(portalBaseUrl(), options.project) : null;
    const suffix = item ? `?projectId=${encodeURIComponent(item.id)}` : "";
    return { activity: await apiGet(portalBaseUrl(), `/api/activity${suffix}`) };
  }
});

const operate = Cli.create("operate", { description: "Operate the app inside prtl chrome with Playwright-style commands", env });
operate.command("snapshot", {
  description: "Return a compact DOM snapshot for the target or feedback iframe.",
  args: z.object({
    project: z.string().describe("Project id, name, port, or registered target id")
  }),
  options: z.object({
    path: z.string().default("/").describe("App path to open in the project"),
    feedback: z.string().optional().describe("Optional feedback request id to open in the chrome"),
    frame: z.enum(["target", "feedback"]).default("target").describe("Which iframe to operate"),
    timeout: z.coerce.number().default(10000).describe("Timeout in milliseconds")
  }),
  run: async ({ args, options, env }) =>
    withOperateFrame(args.project, options, async ({ frame, project, viewerUrl }) => ({
      projectId: project.id,
      projectName: project.name,
      viewerUrl,
      frame: options.frame,
      frameUrl: frame.url(),
      snapshot: await snapshotFrame(frame)
    }))
});
operate.command("click", {
  description: "Click an element inside the target or feedback iframe by selector or visible text.",
  args: z.object({
    project: z.string().describe("Project id, name, port, or registered target id")
  }),
  options: z.object({
    selector: z.string().optional().describe("CSS selector to click"),
    text: z.string().optional().describe("Visible text to click when selector is omitted"),
    path: z.string().default("/").describe("App path to open in the project"),
    feedback: z.string().optional().describe("Optional feedback request id to open in the chrome"),
    frame: z.enum(["target", "feedback"]).default("target").describe("Which iframe to operate"),
    timeout: z.coerce.number().default(10000).describe("Timeout in milliseconds")
  }),
  run: async ({ args, options, env }) =>
    withOperateFrame(args.project, options, async ({ frame, project, viewerUrl }) => {
      if (!options.selector && !options.text) throw new Error("Use --selector or --text");
      if (options.selector) {
        await frame.locator(options.selector).first().click({ timeout: options.timeout });
      } else if (options.text) {
        await frame.getByText(options.text, { exact: false }).first().click({ timeout: options.timeout });
      }
      return {
        action: "click",
        projectId: project.id,
        projectName: project.name,
        viewerUrl,
        frame: options.frame,
        frameUrl: frame.url(),
        selector: options.selector,
        text: options.text
      };
    })
});
operate.command("type", {
  description: "Fill an input, textarea, or contenteditable element inside the target or feedback iframe.",
  args: z.object({
    project: z.string().describe("Project id, name, port, or registered target id")
  }),
  options: z.object({
    selector: z.string().describe("CSS selector to fill"),
    text: z.string().describe("Text to enter"),
    path: z.string().default("/").describe("App path to open in the project"),
    feedback: z.string().optional().describe("Optional feedback request id to open in the chrome"),
    frame: z.enum(["target", "feedback"]).default("target").describe("Which iframe to operate"),
    timeout: z.coerce.number().default(10000).describe("Timeout in milliseconds")
  }),
  run: async ({ args, options, env }) =>
    withOperateFrame(args.project, options, async ({ frame, project, viewerUrl }) => {
      const locator = frame.locator(options.selector).first();
      const before = await elementValue(locator);
      await locator.fill(options.text, { timeout: options.timeout });
      const after = await elementValue(locator);
      return {
        action: "type",
        projectId: project.id,
        projectName: project.name,
        viewerUrl,
        frame: options.frame,
        frameUrl: frame.url(),
        selector: options.selector,
        before,
        after
      };
    })
});
operate.command("press", {
  description: "Press a key inside the target or feedback iframe.",
  args: z.object({
    project: z.string().describe("Project id, name, port, or registered target id"),
    key: z.string().describe("Playwright key name, for example Enter, Escape, or Meta+A")
  }),
  options: z.object({
    selector: z.string().optional().describe("Optional selector to focus before pressing"),
    path: z.string().default("/").describe("App path to open in the project"),
    feedback: z.string().optional().describe("Optional feedback request id to open in the chrome"),
    frame: z.enum(["target", "feedback"]).default("target").describe("Which iframe to operate"),
    timeout: z.coerce.number().default(10000).describe("Timeout in milliseconds")
  }),
  run: async ({ args, options, env }) =>
    withOperateFrame(args.project, options, async ({ frame, project, viewerUrl }) => {
      if (options.selector) {
        await frame.locator(options.selector).first().press(args.key, { timeout: options.timeout });
      } else {
        await frame.locator("body").press(args.key, { timeout: options.timeout });
      }
      return {
        action: "press",
        key: args.key,
        projectId: project.id,
        projectName: project.name,
        viewerUrl,
        frame: options.frame,
        frameUrl: frame.url(),
        selector: options.selector
      };
    })
});
operate.command("wait", {
  description: "Wait inside the target or feedback iframe for a selector or a fixed delay.",
  args: z.object({
    project: z.string().describe("Project id, name, port, or registered target id")
  }),
  options: z.object({
    selector: z.string().optional().describe("Optional selector to wait for"),
    ms: z.coerce.number().default(1000).describe("Delay in milliseconds when selector is omitted"),
    path: z.string().default("/").describe("App path to open in the project"),
    feedback: z.string().optional().describe("Optional feedback request id to open in the chrome"),
    frame: z.enum(["target", "feedback"]).default("target").describe("Which iframe to operate"),
    timeout: z.coerce.number().default(10000).describe("Timeout in milliseconds")
  }),
  run: async ({ args, options, env }) =>
    withOperateFrame(args.project, options, async ({ frame, project, viewerUrl }) => {
      if (options.selector) {
        await frame.locator(options.selector).first().waitFor({ state: "visible", timeout: options.timeout });
      } else {
        await sleep(options.ms);
      }
      return {
        action: "wait",
        projectId: project.id,
        projectName: project.name,
        viewerUrl,
        frame: options.frame,
        frameUrl: frame.url(),
        selector: options.selector,
        ms: options.selector ? undefined : options.ms
      };
    })
});
operate.command("eval", {
  description: "Evaluate JavaScript inside the target or feedback iframe.",
  args: z.object({
    project: z.string().describe("Project id, name, port, or registered target id")
  }),
  options: z.object({
    js: z.string().describe("JavaScript expression or function body to evaluate"),
    path: z.string().default("/").describe("App path to open in the project"),
    feedback: z.string().optional().describe("Optional feedback request id to open in the chrome"),
    frame: z.enum(["target", "feedback"]).default("target").describe("Which iframe to operate"),
    timeout: z.coerce.number().default(10000).describe("Timeout in milliseconds")
  }),
  run: async ({ args, options, env }) =>
    withOperateFrame(args.project, options, async ({ frame, project, viewerUrl }) => ({
      action: "eval",
      projectId: project.id,
      projectName: project.name,
      viewerUrl,
      frame: options.frame,
      frameUrl: frame.url(),
      result: await evaluateUserJavaScript(frame, options.js)
    }))
});
operate.command("run", {
  description: "Run a JSON step file against the target or feedback iframe.",
  args: z.object({
    project: z.string().describe("Project id, name, port, or registered target id"),
    file: z.string().describe("JSON file containing an array of operate steps")
  }),
  options: z.object({
    path: z.string().default("/").describe("App path to open in the project"),
    feedback: z.string().optional().describe("Optional feedback request id to open in the chrome"),
    frame: z.enum(["target", "feedback"]).default("target").describe("Which iframe to operate"),
    timeout: z.coerce.number().default(10000).describe("Timeout in milliseconds")
  }),
  run: async ({ args, options, env }) => {
    const parsed = JSON.parse(await fs.readFile(args.file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${args.file} must contain a JSON array of steps`);
    const steps = parsed.map(normalizeOperateStep);
    return withOperateFrame(args.project, options, async ({ frame, project, viewerUrl }) => {
      const results = [];
      for (const [index, step] of steps.entries()) {
        results.push(await runOperateStep(frame, step, options.timeout, index));
      }
      return {
        action: "run",
        projectId: project.id,
        projectName: project.name,
        viewerUrl,
        frame: options.frame,
        frameUrl: frame.url(),
        results
      };
    });
  }
});

const target = Cli.create("target", { description: "Registered website and HTML artifact feedback targets", env });
target.command("list", {
  description: "List manually registered website and HTML artifact targets.",
  run: async ({ env }) => apiGet<{ targets: RegisteredTarget[] }>(portalBaseUrl(), "/api/targets")
});
target.command("add-url", {
  description: "Register an existing website URL as a prtl feedback target.",
  args: z.object({
    url: z.string().describe("Website URL to view inside prtl")
  }),
  options: z.object({
    name: z.string().optional().describe("Human-readable target name")
  }),
  run: async ({ args, options, env }) => apiPost(portalBaseUrl(), "/api/targets/url", { url: args.url, name: options.name })
});
target.command("add-html", {
  description: "Validate and register a local HTML file as a prtl feedback target.",
  args: z.object({
    file: z.string().describe("Local HTML file")
  }),
  options: z.object({
    name: z.string().optional().describe("Human-readable target name"),
    artifactKind: z.string().optional().describe("Optional artifact kind: plan, review, explainer, report, prototype, editor, deck"),
    tag: z.array(z.string()).default([]).describe("Artifact tag. Repeat for multiple tags.")
  }),
  run: async ({ args, options, env }) =>
    apiPost(portalBaseUrl(), "/api/targets/html", { file: args.file, name: options.name, artifactKind: options.artifactKind, tags: options.tag })
});
target.command("remove", {
  description: "Remove a manually registered target.",
  args: z.object({
    targetId: z.string().describe("Target id")
  }),
  run: async ({ args, env }) => apiDelete(portalBaseUrl(), `/api/targets/${encodeURIComponent(args.targetId)}`)
});

const html = Cli.create("html", { description: "HTML artifact compatibility, import, and review helpers", env });
html.command("brief", {
  description: "Show the prtl chrome contract for an HTML artifact kind.",
  args: z.object({
    kind: z.string().describe("Artifact kind: plan, review, explainer, report, prototype, editor, deck")
  }),
  run: async ({ args, env }) => apiGet(portalBaseUrl(), `/api/html/brief/${encodeURIComponent(args.kind)}`)
});
html.command("feedback-brief", {
  description: "Show the prtl chrome feedback-surface bridge contract plus optional library notes.",
  options: z.object({
    libraries: z.string().default("shadcn,vanilla-js").describe("Comma-separated library packs to include")
  }),
  run: async ({ options, env }) => {
    const [brief, libraries] = await Promise.all([
      apiGet<{ kind: string; brief: string }>(portalBaseUrl(), "/api/html/brief/feedback-surface"),
      apiGet<{ libraries: string[]; context: string }>(portalBaseUrl(), `/api/html/context?libraries=${encodeURIComponent(options.libraries)}`)
    ]);
    return { kind: brief.kind, brief: brief.brief, libraries: libraries.libraries, context: libraries.context };
  }
});
html.command("context", {
  description: "Show compact library and interaction-contract notes for prtl-compatible HTML.",
  options: z.object({
    libraries: z.string().default("tailwind,shadcn,vanilla-js").describe("Comma-separated library packs"),
    designSystem: z.string().optional().describe("Optional design-system guidance file to append")
  }),
  run: async ({ options, env }) => {
    const payload = await apiGet<{ libraries: string[]; context: string }>(portalBaseUrl(), `/api/html/context?libraries=${encodeURIComponent(options.libraries)}`);
    if (!options.designSystem) return payload;
    const designSystem = await fs.readFile(options.designSystem, "utf8");
    return { ...payload, context: `${payload.context}\n\n---\n\n# Project Design System\n\n${designSystem}` };
  }
});
html.command("validate", {
  description: "Check whether a standalone HTML file works cleanly inside the prtl chrome.",
  args: z.object({
    file: z.string().describe("Local HTML file")
  }),
  run: async ({ args, env }) => apiPost(portalBaseUrl(), "/api/html/validate", { file: args.file })
});
html.command("validate-feedback", {
  description: "Check whether custom feedback HTML can talk to the prtl chrome bridge.",
  args: z.object({
    file: z.string().describe("Local feedback-surface HTML file")
  }),
  run: async ({ args, env }) => apiPost(portalBaseUrl(), "/api/html/feedback/validate", { file: args.file })
});
html.command("import", {
  description: "Validate and register an existing local HTML file as a prtl target.",
  args: z.object({
    file: z.string().describe("Local HTML file")
  }),
  options: z.object({
    name: z.string().optional().describe("Human-readable target name"),
    artifactKind: z.string().optional().describe("Optional artifact kind"),
    tag: z.array(z.string()).default([]).describe("Artifact tag. Repeat for multiple tags.")
  }),
  run: async ({ args, options, env }) =>
    apiPost(portalBaseUrl(), "/api/targets/html", { file: args.file, name: options.name, artifactKind: options.artifactKind, tags: options.tag })
});
html.command("list", {
  description: "List registered HTML artifacts.",
  run: async ({ env }) => apiGet<{ artifacts: HtmlArtifactSummary[] }>(portalBaseUrl(), "/api/html/artifacts")
});
html.command("show", {
  description: "Show one registered HTML artifact.",
  args: z.object({
    artifact: z.string().describe("Artifact id or name")
  }),
  run: async ({ args, env }) => getHtmlArtifactByIdOrName(args.artifact)
});
html.command("open", {
  description: "Open a registered HTML artifact in the local browser.",
  args: z.object({
    artifact: z.string().describe("Artifact id or name")
  }),
  run: async ({ args, env }) => {
    const artifact = await getHtmlArtifactByIdOrName(args.artifact);
    const url = `${portalBaseUrl()}${artifact.viewerUrl}`;
    await execFileAsync("open", [url]);
    return { id: artifact.id, name: artifact.name, url };
  }
});
html.command("screenshot", {
  description: "Capture phone, tablet, and desktop screenshots for an HTML artifact.",
  args: z.object({
    artifact: z.string().describe("Artifact id or name")
  }),
  run: async ({ args, env }) => {
    const artifact = await getHtmlArtifactByIdOrName(args.artifact);
    return apiPost(portalBaseUrl(), `/api/projects/${encodeURIComponent(artifact.id)}/screenshots`, {});
  }
});
html.command("remove", {
  description: "Remove a registered HTML artifact.",
  args: z.object({
    artifact: z.string().describe("Artifact id or name")
  }),
  run: async ({ args, env }) => {
    const artifact = await getHtmlArtifactByIdOrName(args.artifact);
    return apiDelete(portalBaseUrl(), `/api/targets/${encodeURIComponent(artifact.id)}`);
  }
});
html.command("export", {
  description: "Export an artifact id or local HTML file as a portable static folder.",
  args: z.object({
    artifact: z.string().describe("Artifact id, artifact name, or local HTML file")
  }),
  options: z.object({
    out: z.string().describe("Output directory")
  }),
  run: async ({ args, options, env }) => exportHtmlArtifactInput(args.artifact, options.out)
});
html.command("share", {
  description: "Return a local/Tailscale viewer URL for an HTML artifact or file.",
  args: z.object({
    artifact: z.string().describe("Artifact id, artifact name, or local HTML file")
  }),
  run: async ({ args, env }) => {
    const artifact = await resolveHtmlArtifactOrImport(args.artifact);
    const health = await apiGet<{ tailscaleServe?: string; publicBaseUrl?: string; localUrl?: string; warnings?: string[] }>(portalBaseUrl(), "/api/health");
    return {
      id: artifact.id,
      name: artifact.name,
      localUrl: `${health.localUrl ?? portalBaseUrl()}${artifact.viewerUrl}`,
      publicUrl: `${health.publicBaseUrl ?? portalBaseUrl()}${artifact.viewerUrl}`,
      httpsConfirmed: health.tailscaleServe === "configured",
      warnings: health.tailscaleServe === "configured" ? [] : ["Tailscale Serve is not confirmed for the public URL."]
    };
  }
});
html.command("diff", {
  description: "Show semantic differences between two HTML files.",
  args: z.object({
    before: z.string().describe("Before HTML file"),
    after: z.string().describe("After HTML file")
  }),
  run: async ({ args, env }) => diffHtmlFiles(args.before, args.after)
});
html.command("normalize", {
  description: "Check deterministic HTML whitespace normalization without rewriting by default.",
  args: z.object({
    file: z.string().describe("HTML file")
  }),
  options: z.object({
    check: z.boolean().default(true).describe("Check only")
  }),
  run: async ({ args, options, env }) => {
    const result = await checkNormalizedHtml(args.file);
    return options.check ? { file: result.file, changed: result.changed } : result;
  }
});
html.command("bundle", {
  description: "Create a repo context bundle to send through the prtl HTML feedback loop.",
  args: z.object({
    kind: z.enum(["plan", "review", "explainer", "report"]).describe("Bundle kind")
  }),
  options: z.object({
    cwd: z.string().default(process.cwd()).describe("Repository or folder to inspect"),
    out: z.string().optional().describe("Optional output file")
  }),
  run: async ({ args, options, env }) => {
    const text = await buildHtmlContextBundle(args.kind, options.cwd);
    if (options.out) await fs.writeFile(options.out, text, "utf8");
    return { kind: args.kind, cwd: path.resolve(options.cwd), out: options.out ? path.resolve(options.out) : null, text: options.out ? undefined : text };
  }
});

const designSystem = Cli.create("design-system", { description: "Create project-specific chrome/library style guidance", env });
designSystem.command("scan", {
  description: "Scan a codebase for design-system signals and emit reusable guidance.",
  options: z.object({
    cwd: z.string().default(process.cwd()).describe("Repository or folder to scan"),
    out: z.string().optional().describe("Optional output file")
  }),
  run: async ({ options, env }) => {
    const text = await scanDesignSystem(options.cwd);
    if (options.out) await fs.writeFile(options.out, text, "utf8");
    return { cwd: path.resolve(options.cwd), out: options.out ? path.resolve(options.out) : null, text: options.out ? undefined : text };
  }
});
html.command(designSystem);

const guidance = Cli.create("guidance", { description: "Inspect prtl chrome skill and library packs", env });
guidance.command("list", {
  description: "List available prtl chrome skill and library packs.",
  run: async ({ env }) => apiGet(portalBaseUrl(), "/api/html/guidance")
});
guidance.command("show", {
  description: "Show one prtl chrome skill or library pack.",
  args: z.object({
    name: z.string().describe("Pack name")
  }),
  options: z.object({
    type: z.enum(["skills", "libraries"]).default("skills").describe("Pack collection")
  }),
  run: async ({ args, options, env }) =>
    apiGet(portalBaseUrl(), `/api/html/guidance/${encodeURIComponent(options.type)}/${encodeURIComponent(args.name)}`)
});
html.command(guidance);

const library = Cli.create("library", { description: "Inspect libraries and interaction contracts available to prtl-wrapped HTML", env });
library.command("list", {
  description: "List available prtl library and skill packs.",
  run: async ({ env }) => apiGet(portalBaseUrl(), "/api/html/guidance")
});
library.command("show", {
  description: "Show one library or skill pack.",
  args: z.object({
    name: z.string().describe("Pack name")
  }),
  options: z.object({
    type: z.enum(["libraries", "skills"]).default("libraries").describe("Pack collection")
  }),
  run: async ({ args, options, env }) =>
    apiGet(portalBaseUrl(), `/api/html/guidance/${encodeURIComponent(options.type)}/${encodeURIComponent(args.name)}`)
});
library.command("context", {
  description: "Show the selected library notes plus optional project design-system guidance.",
  options: z.object({
    libraries: z.string().default("tailwind,shadcn,vanilla-js").describe("Comma-separated library packs"),
    designSystem: z.string().optional().describe("Optional design-system guidance file to append")
  }),
  run: async ({ options, env }) => {
    const payload = await apiGet<{ libraries: string[]; context: string }>(portalBaseUrl(), `/api/html/context?libraries=${encodeURIComponent(options.libraries)}`);
    if (!options.designSystem) return payload;
    const designSystem = await fs.readFile(options.designSystem, "utf8");
    return { ...payload, context: `${payload.context}\n\n---\n\n# Project Design System\n\n${designSystem}` };
  }
});

const bridge = Cli.create("bridge", { description: "Inspect the prtl chrome runtime bridge injected into feedback HTML", env });
bridge.command("show", {
  description: "Show the feedback bridge API available as window.prtl.feedback inside custom feedback HTML.",
  run: async () => ({
    injectedInto: "custom feedback-surface iframes",
    global: "window.prtl.feedback",
    methods: [
      { name: "ready(detail?)", posts: "prtl.feedback.ready", purpose: "Tell the chrome the feedback surface is initialized." },
      { name: "resize(height)", posts: "prtl.feedback.resize", purpose: "Ask the chrome to resize the feedback surface." },
      { name: "capture()", posts: "prtl.feedback.capture", purpose: "Ask prtl to capture screenshots for the active request." },
      { name: "submit({ kind, text, choice, data })", posts: "prtl.feedback.submit", purpose: "Send structured feedback back to the terminal workflow." }
    ],
    compatibility: "Raw window.parent.postMessage({ type: 'prtl.feedback.*', ... }, '*') still works.",
    example: [
      "window.prtl.feedback.ready();",
      "window.prtl.feedback.submit({ kind: 'note', text: 'Use the denser layout', data: { density: 'compact' } });"
    ].join("\n")
  })
});

const portal = Cli.create("portal", { description: "Portal health and logs", env });
portal.command("health", {
  description: "Show portal health.",
  run: async ({ env }) => apiGet(portalBaseUrl(), "/api/health")
});
portal.command("doctor", {
  description: "Check whether prtl is ready for machine-wide agent use.",
  run: async ({ env }) => doctor()
});
portal.command("logs", {
  description: "Tail portal launchd logs through the portal command runner.",
  run: async ({ env }) => {
    const data = await apiGet<{ projects: ProjectInfo[] }>(portalBaseUrl(), "/api/projects");
    const first = data.projects[0];
    if (!first) return { error: "No projects available to attach command history" };
    return apiPost(portalBaseUrl(), `/api/projects/${encodeURIComponent(first.id)}/commands`, {
      command: "tail -80 .prtl/logs/stderr.log .prtl/logs/stdout.log",
      cwd: "/Users/douglance/Developer/lv/prtl"
    });
  }
});

cli.command("doctor", {
  description: "Check whether prtl is ready for machine-wide agent use.",
  run: async ({ env }) => doctor()
});

cli
  .command(project)
  .command(request)
  .command(feedback)
  .command(device)
  .command(target)
  .command(library)
  .command(bridge)
  .command(html)
  .command(command)
  .command(screenshot)
  .command(activity)
  .command(operate)
  .command(portal);

export async function cliFetch(req: Request): Promise<Response> {
  return cli.fetch(req);
}

async function resolveProject(baseUrl: string, identifier: string): Promise<ProjectInfo> {
  const data = await apiGet<{ projects: ProjectInfo[] }>(baseUrl, "/api/projects");
  const lowered = identifier.toLowerCase();
  const project = data.projects.find(
    (item) =>
      item.id === identifier ||
      item.name.toLowerCase() === lowered ||
      String(item.port) === identifier ||
      item.id.includes(lowered)
  );
  if (!project) throw new Error(`Project not found: ${identifier}`);
  return project;
}

type OperateFrameName = "target" | "feedback";

type OperateOptions = {
  path: string;
  feedback?: string;
  frame: OperateFrameName;
  timeout: number;
};

type OperateContext = {
  page: Page;
  frame: Frame;
  project: OperateProject;
  viewerUrl: string;
};

type OperateProject = Pick<ProjectInfo, "id" | "name">;

type OperateStep =
  | { action: "click"; selector?: string; text?: string }
  | { action: "type"; selector: string; text: string }
  | { action: "press"; key: string; selector?: string }
  | { action: "wait"; selector?: string; ms?: number }
  | { action: "eval"; js: string }
  | { action: "snapshot" };

async function withOperateFrame<T>(
  projectIdentifier: string,
  options: OperateOptions,
  callback: (context: OperateContext) => Promise<T>
): Promise<T> {
  const { chromium } = await import("playwright");
  const project = await resolveOperateProject(portalBaseUrl(), projectIdentifier);
  const viewerUrl = viewerUrlForProject(project, options);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: options.timeout });
    const frame = await findOperateFrame(page, options.frame, options.timeout);
    await frame.locator("body").waitFor({ state: "attached", timeout: options.timeout });
    return await callback({ page, frame, project, viewerUrl });
  } finally {
    await browser.close();
  }
}

async function resolveOperateProject(baseUrl: string, identifier: string): Promise<OperateProject> {
  if (identifier.startsWith("http://") || identifier.startsWith("https://")) {
    return apiPost<ProjectInfo>(baseUrl, "/api/targets/url", { url: identifier, name: identifier });
  }
  try {
    return await resolveProject(baseUrl, identifier);
  } catch (error) {
    const data = await apiGet<{ targets: RegisteredTarget[] }>(baseUrl, "/api/targets");
    const lowered = identifier.toLowerCase();
    const target = data.targets.find(
      (item) =>
        item.id === identifier ||
        item.name.toLowerCase() === lowered ||
        item.url === identifier ||
        item.id.includes(lowered)
    );
    if (target) return { id: target.id, name: target.name };
    throw error;
  }
}

function viewerUrlForProject(project: OperateProject, options: Pick<OperateOptions, "path" | "feedback">): string {
  const params = new URLSearchParams();
  if (options.path) params.set("path", options.path);
  if (options.feedback) params.set("feedback", options.feedback);
  const suffix = params.size ? `?${params.toString()}` : "";
  return `${portalBaseUrl()}/view/${encodeURIComponent(project.id)}${suffix}`;
}

async function findOperateFrame(page: Page, frameName: OperateFrameName, timeout: number): Promise<Frame> {
  const selector = frameName === "target" ? ".viewerFrameWrap iframe" : ".feedbackSurface iframe";
  const handle = await page.locator(selector).first().elementHandle({ timeout });
  if (!handle) throw new Error(`Could not find ${frameName} iframe in prtl chrome`);
  const frame = await handle.contentFrame();
  if (!frame) throw new Error(`Could not attach to ${frameName} iframe in prtl chrome`);
  return frame;
}

async function elementValue(locator: Locator): Promise<string | null> {
  return locator
    .evaluate(
      new Function(
        "node",
        `
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
          return node.value;
        }
        return node.textContent;
      `
      ) as (node: Element) => string | null
    )
    .catch(() => null);
}

async function snapshotFrame(frame: Frame) {
  return frame.evaluate(
    new Function(`
      const text = (document.body && document.body.innerText ? document.body.innerText : "").replace(/\\s+/g, " ").trim();
      const mapElements = (items, mapper) => items.slice(0, 40).map((item) => ({
        tag: item.tagName.toLowerCase(),
        text: (item.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
        ...mapper(item)
      }));
      return {
        title: document.title,
        url: location.href,
        text: text.slice(0, 2000),
        headings: mapElements(Array.from(document.querySelectorAll("h1,h2,h3")), () => ({})),
        buttons: mapElements(Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']")), (item) => ({
          ariaLabel: item.getAttribute("aria-label"),
          disabled: item instanceof HTMLButtonElement || item instanceof HTMLInputElement ? item.disabled : undefined
        })),
        inputs: Array.from(document.querySelectorAll("input,textarea,select"))
          .slice(0, 40)
          .map((item) => ({
            tag: item.tagName.toLowerCase(),
            type: item instanceof HTMLInputElement ? item.type : undefined,
            name: item.getAttribute("name"),
            placeholder: item.getAttribute("placeholder"),
            value: item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement || item instanceof HTMLSelectElement ? item.value : ""
          })),
        links: mapElements(Array.from(document.querySelectorAll("a[href]")), (item) => ({
          href: item.getAttribute("href")
        }))
      };
    `) as () => unknown
  );
}

async function evaluateUserJavaScript(frame: Frame, source: string): Promise<unknown> {
  return frame.evaluate(
    new Function("source", "return (0, eval)(source);") as (source: string) => unknown,
    source
  );
}

function normalizeOperateStep(step: unknown): OperateStep {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new Error("Each operate step must be an object");
  }
  const record = step as Record<string, unknown>;
  if (record.action === "click") {
    const selector = optionalString(record.selector, "selector");
    const text = optionalString(record.text, "text");
    if (!selector && !text) throw new Error("click steps require selector or text");
    return { action: "click", selector, text };
  }
  if (record.action === "type") {
    return { action: "type", selector: requiredString(record.selector, "selector"), text: requiredString(record.text, "text") };
  }
  if (record.action === "press") {
    return { action: "press", key: requiredString(record.key, "key"), selector: optionalString(record.selector, "selector") };
  }
  if (record.action === "wait") {
    return { action: "wait", selector: optionalString(record.selector, "selector"), ms: optionalNumber(record.ms, "ms") };
  }
  if (record.action === "eval") {
    return { action: "eval", js: requiredString(record.js, "js") };
  }
  if (record.action === "snapshot") return { action: "snapshot" };
  throw new Error(`Unsupported operate step action: ${String(record.action)}`);
}

async function runOperateStep(frame: Frame, step: OperateStep, timeout: number, index: number): Promise<Record<string, unknown>> {
  if (step.action === "click") {
    if (step.selector) {
      await frame.locator(step.selector).first().click({ timeout });
    } else if (step.text) {
      await frame.getByText(step.text, { exact: false }).first().click({ timeout });
    }
    return { index, action: "click", selector: step.selector, text: step.text };
  }
  if (step.action === "type") {
    const locator = frame.locator(step.selector).first();
    const before = await elementValue(locator);
    await locator.fill(step.text, { timeout });
    const after = await elementValue(locator);
    return { index, action: "type", selector: step.selector, before, after };
  }
  if (step.action === "press") {
    if (step.selector) {
      await frame.locator(step.selector).first().press(step.key, { timeout });
    } else {
      await frame.locator("body").press(step.key, { timeout });
    }
    return { index, action: "press", key: step.key, selector: step.selector };
  }
  if (step.action === "wait") {
    if (step.selector) {
      await frame.locator(step.selector).first().waitFor({ state: "visible", timeout });
    } else {
      await sleep(step.ms ?? 1000);
    }
    return { index, action: "wait", selector: step.selector, ms: step.selector ? undefined : step.ms ?? 1000 };
  }
  if (step.action === "eval") {
    return { index, action: "eval", result: await evaluateUserJavaScript(frame, step.js) };
  }
  return { index, action: "snapshot", snapshot: await snapshotFrame(frame) };
}

async function getHtmlArtifactByIdOrName(identifier: string): Promise<HtmlArtifactSummary> {
  const data = await apiGet<{ artifacts: HtmlArtifactSummary[] }>(portalBaseUrl(), "/api/html/artifacts");
  const lowered = identifier.toLowerCase();
  const artifact = data.artifacts.find(
    (item) => item.id === identifier || item.name.toLowerCase() === lowered || item.id.includes(lowered)
  );
  if (!artifact) throw new Error(`HTML artifact not found: ${identifier}`);
  return artifact;
}

async function resolveHtmlArtifactOrImport(input: string): Promise<HtmlArtifactSummary> {
  if (await fileExists(input)) {
    const result = await apiPost<{ project: ProjectInfo }>(portalBaseUrl(), "/api/targets/html", { file: input });
    return getHtmlArtifactByIdOrName(result.project.id);
  }
  return getHtmlArtifactByIdOrName(input);
}

async function exportHtmlArtifactInput(input: string, outDir: string) {
  if (await fileExists(input)) return exportLocalHtmlFile(input, outDir);
  const artifact = await getHtmlArtifactByIdOrName(input);
  return apiPost(portalBaseUrl(), `/api/html/artifacts/${encodeURIComponent(artifact.id)}/export`, { outDir: path.resolve(outDir) });
}

async function exportLocalHtmlFile(file: string, outDir: string) {
  const resolvedFile = path.resolve(file);
  const resolvedOut = path.resolve(outDir);
  const summary = await summarizeHtmlFile(resolvedFile);
  await fs.mkdir(resolvedOut, { recursive: true });
  const htmlOut = path.join(resolvedOut, "artifact.html");
  const metaOut = path.join(resolvedOut, "metadata.json");
  const indexOut = path.join(resolvedOut, "index.html");
  await fs.copyFile(resolvedFile, htmlOut);
  await fs.writeFile(metaOut, JSON.stringify({ sourceFile: resolvedFile, summary }, null, 2), "utf8");
  await fs.writeFile(indexOut, portableIndexHtml(summary.title ?? path.basename(resolvedFile)), "utf8");
  return { file: resolvedFile, outDir: resolvedOut, files: [htmlOut, metaOut, indexOut] };
}

function portableIndexHtml(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #11151b; color: #f7f8fa; }
    body { margin: 0; }
    header { padding: 14px 16px; border-bottom: 1px solid #2c333d; background: #151a21; }
    h1 { margin: 0; font-size: 1rem; }
    iframe { width: 100%; height: calc(100dvh - 53px); border: 0; background: white; }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(title)}</h1></header>
  <iframe title="${escapeHtml(title)}" src="artifact.html"></iframe>
</body>
</html>`;
}

function formatFeedbackExport(request: FeedbackRequest, format: "prompt" | "markdown"): string {
  const lines = [
    format === "prompt" ? "Use this prtl feedback to update the product/artifact." : `# Feedback: ${request.projectName}`,
    "",
    `Request: ${request.prompt}`,
    request.context ? `Context: ${request.context}` : "",
    `Project: ${request.projectName} (${request.projectId})`,
    `Path: ${request.appPath}`,
    `Status: ${request.status}`,
    request.isStale ? `Stale: ${request.staleReason ?? "yes"}` : "",
    "",
    "## Responses",
    request.responses.length
      ? request.responses.map((response) => `- ${response.kind}: ${response.text}${response.choice ? ` (choice: ${response.choice})` : ""}${response.data ? `\n  data: ${JSON.stringify(response.data)}` : ""}`).join("\n")
      : "- No responses yet.",
    "",
    "## Tracked Edits",
    request.edits.length
      ? request.edits.map((edit) => `- ${edit.selector || edit.targetId}: "${edit.before}" -> "${edit.after}"`).join("\n")
      : "- No tracked edits.",
    "",
    "## Artifacts",
    request.artifacts.length
      ? request.artifacts.map((artifact) => `- ${artifact.label}: ${artifact.url ?? "(missing)"}`).join("\n")
      : "- No screenshots captured.",
    "",
    "Apply the feedback, preserve the user's intent, and revalidate the exact affected surface."
  ];
  return lines.filter(Boolean).join("\n");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, key);
}

function optionalNumber(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function apiPost<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function apiPatch<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function apiDelete<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function resolveFeedbackTarget(
  project: string | undefined,
  options: { url?: string; html?: string; name?: string; artifactKind?: string }
): Promise<ProjectInfo> {
  if (options.url && options.html) throw new Error("Use either --url or --html, not both");
  if (options.url) {
    return apiPost<ProjectInfo>(portalBaseUrl(), "/api/targets/url", { url: options.url, name: options.name });
  }
  if (options.html) {
    const result = await apiPost<{ project: ProjectInfo }>(portalBaseUrl(), "/api/targets/html", {
      file: options.html,
      name: options.name,
      artifactKind: options.artifactKind
    });
    return result.project;
  }
  if (!project) throw new Error("project is required unless --url or --html is provided");
  return resolveProject(portalBaseUrl(), project);
}

async function doctor() {
  const checks = await Promise.all([
    checkCliPath(),
    checkLaunchd(),
    checkHealth(),
    checkNotifications(),
    checkProjects(),
    checkMcp()
  ]);
  const ready = checks.every((check) => check.ok || check.level === "warn");
  return {
    ready,
    baseUrl: portalBaseUrl(),
    checks,
    nextSteps: checks
      .filter((check) => !check.ok)
      .map((check) => ("fix" in check ? check.fix : undefined))
      .filter(Boolean)
  };
}

async function checkCliPath() {
  const expected = `${process.env.HOME ?? ""}/bin/prtl`;
  const pathEntries = (process.env.PATH ?? "").split(":");
  const homeBinOnPath = pathEntries.includes(`${process.env.HOME ?? ""}/bin`);
  try {
    const { stdout } = await execFileAsync("which", ["prtl"], { timeout: 2000 });
    const command = stdout.trim();
    return {
      id: "cli-path",
      ok: command.length > 0 && homeBinOnPath,
      level: command.length > 0 && homeBinOnPath ? "pass" : "warn",
      message: command.length > 0 ? `prtl resolves to ${command}` : "prtl is not on PATH",
      fix: homeBinOnPath ? undefined : `Add ${process.env.HOME}/bin to PATH; install with npm run install:global`
    };
  } catch {
    return {
      id: "cli-path",
      ok: false,
      level: "fail",
      message: "prtl is not globally available",
      fix: `Run npm run install:global to create ${expected}`
    };
  }
}

async function checkLaunchd() {
  try {
    await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? process.env.UID}/com.douglance.prtl`], { timeout: 3000 });
    return { id: "launchd", ok: true, level: "pass", message: "launchd service is loaded" };
  } catch {
    return {
      id: "launchd",
      ok: false,
      level: "fail",
      message: "launchd service is not loaded",
      fix: "Run npm run launchd:install"
    };
  }
}

async function checkHealth() {
  try {
    const health = await apiGet<{
      ok: boolean;
      tailscaleServe?: string;
      onlineProjectCount?: number;
      warnings?: string[];
    }>(portalBaseUrl(), "/api/health");
    return {
      id: "portal-health",
      ok: Boolean(health.ok) && health.tailscaleServe === "configured",
      level: Boolean(health.ok) && health.tailscaleServe === "configured" ? "pass" : "fail",
      message: health.ok ? `portal reachable; tailscale=${health.tailscaleServe}` : "portal health is not OK",
      data: health,
      fix: health.tailscaleServe === "configured" ? undefined : "Run npm run launchd:install to restore Tailscale Serve"
    };
  } catch (error) {
    return {
      id: "portal-health",
      ok: false,
      level: "fail",
      message: error instanceof Error ? error.message : "portal is unreachable",
      fix: "Run npm run launchd:install"
    };
  }
}

async function checkNotifications() {
  try {
    const status = await apiGet<{
      subscriptionCount: number;
      apnsDeviceCount?: number;
      apnsConfigured?: boolean;
      nativeReady?: boolean;
      apnsIssues?: string[];
      apnsLastError?: string | null;
    }>(portalBaseUrl(), "/api/notifications/status");
    const nativeCount = status.apnsDeviceCount ?? 0;
    const channelCount = status.subscriptionCount + nativeCount;
    const apnsBlocked = nativeCount > 0 && status.apnsConfigured === false;
    const apnsUnhealthy = nativeCount > 0 && status.nativeReady === false;
    const ok = channelCount > 0 && !apnsBlocked && !apnsUnhealthy;
    const channelSummary = `${status.subscriptionCount} web, ${nativeCount} native`;
    return {
      id: "notifications",
      ok,
      level: ok ? "pass" : "warn",
      message: ok
        ? `${channelSummary} notification channel(s)`
        : apnsBlocked
          ? `${channelSummary}; APNs setup incomplete`
          : apnsUnhealthy
            ? `${channelSummary}; APNs delivery failed`
          : "no subscribed devices; feedback still works but lock-screen notifications will not",
      data: status,
      fix: ok
        ? undefined
        : apnsBlocked
          ? `Set APNs server config: ${(status.apnsIssues ?? ["PRTL_APNS_TEAM_ID", "PRTL_APNS_KEY_ID", "PRTL_APNS_KEY_PATH", "PRTL_APNS_TOPIC"]).join(", ")}`
          : apnsUnhealthy
            ? `Fix APNs delivery: ${status.apnsLastError ?? "send a test notification and inspect /api/devices"}`
          : "Open the portal bell on the target device and enable notifications"
    };
  } catch (error) {
    return {
      id: "notifications",
      ok: false,
      level: "warn",
      message: error instanceof Error ? error.message : "notification status unavailable",
      fix: "Open the portal bell and enable notifications"
    };
  }
}

async function checkProjects() {
  try {
    const data = await apiGet<{ projects: ProjectInfo[] }>(portalBaseUrl(), "/api/projects");
    const online = data.projects.filter((project) => project.compatibility.level !== "broken");
    return {
      id: "projects",
      ok: online.length > 0,
      level: online.length > 0 ? "pass" : "warn",
      message: `${online.length}/${data.projects.length} usable project(s) discovered`,
      data: { projectCount: data.projects.length, usableProjectCount: online.length },
      fix: online.length > 0 ? undefined : "Start a localhost project, then run prtl project list"
    };
  } catch (error) {
    return {
      id: "projects",
      ok: false,
      level: "warn",
      message: error instanceof Error ? error.message : "project discovery unavailable",
      fix: "Start the portal and run prtl project list"
    };
  }
}

async function checkMcp() {
  return {
    id: "mcp",
    ok: true,
    level: "pass",
    message: "MCP command available: prtl --mcp",
    data: { command: "prtl --mcp" }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli.serve();
}

function portalBaseUrl(): string {
  return process.env.PRTL_BASE_URL ?? "https://doug-mm.tail5d92b4.ts.net";
}

function withFeedbackUrl(request: FeedbackRequest) {
  return {
    ...request,
    viewerUrl: feedbackViewerUrl(request)
  };
}

function summarizeFeedback(request: FeedbackRequest) {
  return {
    id: request.id,
    projectId: request.projectId,
    projectName: request.projectName,
    status: request.status satisfies FeedbackStatus,
    prompt: request.prompt,
    appPath: request.appPath,
    isStale: request.isStale,
    projectAvailable: request.projectAvailable,
    updatedAt: request.updatedAt,
    responses: request.responses.length,
    metrics: request.metrics,
    viewerUrl: feedbackViewerUrl(request)
  };
}

function feedbackViewerUrl(request: FeedbackRequest): string {
  const params = new URLSearchParams({ path: request.appPath, feedback: request.id });
  return `${portalBaseUrl()}/view/${request.projectId}?${params.toString()}`;
}

async function waitForRequest(requestId: string, timeout: number): Promise<ReturnType<typeof withRequestUrl> | { timeout: true; requestId: string }> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const request = await apiGet<RequestRecord>(portalBaseUrl(), `/api/requests/${requestId}`);
    if (["answered", "acted", "resolved", "stale", "expired"].includes(request.status)) return withRequestUrl(request);
    await sleep(1500);
  }
  return { timeout: true, requestId };
}

function withRequestUrl(request: RequestRecord) {
  return {
    ...request,
    viewerUrl: requestViewerUrl(request)
  };
}

function summarizeRequest(request: RequestRecord) {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    prompt: request.prompt,
    status: request.status,
    projectId: request.target.projectId,
    projectName: request.target.projectName,
    choices: request.choices,
    responses: request.responses.length,
    attachments: request.attachments.length,
    updatedAt: request.updatedAt,
    viewerUrl: requestViewerUrl(request)
  };
}

function requestViewerUrl(request: RequestRecord): string {
  if (request.target.url?.startsWith("http://") || request.target.url?.startsWith("https://")) return request.target.url;
  if (request.target.url?.startsWith("/")) return `${portalBaseUrl()}${request.target.url}`;
  if (!request.target.projectId) return portalBaseUrl();
  const params = new URLSearchParams({ path: request.target.appPath ?? "/" });
  return `${portalBaseUrl()}/view/${request.target.projectId}?${params.toString()}`;
}

function parseOptionalObject(
  value: string | undefined,
  flag: string,
  fallback: Record<string, unknown> | undefined = {}
): Record<string, unknown> | undefined {
  if (!value) return fallback;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
