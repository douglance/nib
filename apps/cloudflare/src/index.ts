import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { HostedRequestCoreService, type KeyValueStore } from "./hosted-request-core";
import { R2MediaStore } from "./r2-media-store";
import { reviewPageHeaders, reviewPageHtml } from "./review-page";
import { isLegacyAuthRoute } from "./legacy-auth-policy";
import { publicTenantId, stubForTenant, trustedTenantId } from "./tenant-routing";
import {
  tenantReviewRoute,
  tenantScopedReviewApiResponse,
  tenantScopedReviewResponse,
} from "./tenant-review-routing";
import { compareRecordsByRecency, isTopLevelRequestStorageKey } from "./record-order";
import { ApnsClient, type ApnsEnv, type ApnsMessage } from "./apns";

interface Env extends ApnsEnv {
  REQUESTS: DurableObjectNamespace<NibRequestHub>;
  MEDIA: R2Bucket;
  NIB_TENANT_ID?: string;
  NIB_CONTINUATION_HMAC_SECRET?: string;
}

type JsonObject = Record<string, unknown>;

interface RequestAttachment {
  id: string;
  requestId: string;
  name: string;
  type: "image" | "video" | "audio" | "document" | "file";
  contentType: string;
  bytes: number;
  url: string;
  createdAt: string;
  metadata: JsonObject;
}

interface RequestResponse {
  id: string;
  kind: string;
  text: string;
  choice?: string;
  choiceIndex?: number;
  data?: JsonObject | null;
  deviceId?: string;
  attachments?: RequestAttachment[];
  transcript?: JsonObject;
  createdAt: string;
}

interface AuthContext {
  subject: string;
}

interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  pushKind: string;
  token: string;
  apnsTopic: string | null;
  capabilities: string[];
  lastSuccessAt: string | null;
  lastError: string | null;
  updatedAt: string;
  authSubject: string;
}

interface RequestRecord {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  body: string | null;
  context: string | null;
  choices: string[];
  allowText: boolean;
  target: JsonObject;
  status: string;
  priority: "low" | "normal" | "high";
  source: string | null;
  createdAt: string;
  updatedAt: string;
  viewedAt: string | null;
  answeredAt: string | null;
  actedAt: string | null;
  resolvedAt: string | null;
  expiresAt: string | null;
  publishedAt: string | null;
  notifiedAt: string | null;
  notificationClickedAt: string | null;
  staleReason: string | null;
  attachments: RequestAttachment[];
  responses: RequestResponse[];
  metadata: JsonObject;
}

const MAX_ATTACHMENT_BYTES = 96 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleWorkerRequest(request, env, publicTenantId(env, request));
  }
};

export class NibGlobalEntrypoint extends WorkerEntrypoint<Env> {
  async fetchForTenant(request: Request, tenantId: string, subject: string): Promise<Response> {
    const tenant = trustedTenantId(tenantId);
    const response = await handleWorkerRequest(request, this.env, tenant, {
      subject,
    });
    return tenantScopedReviewResponse(response, tenant);
  }
}

async function handleWorkerRequest(
  request: Request,
  env: Env,
  tenant: string,
  trustedAuth?: AuthContext
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (url.pathname === "/api/health") {
    return json({ ok: true, service: "nib-global", durable: true, media: "r2" });
  }
  const scopedReview = tenantReviewRoute(url.pathname);
  if (scopedReview?.kind === "page" && request.method === "GET") {
    trustedTenantId(scopedReview.tenantId);
    return requestPage(scopedReview.requestId, url.origin, scopedReview.apiPrefix);
  }
  if (scopedReview?.kind === "api") {
    const tenantId = trustedTenantId(scopedReview.tenantId);
    const innerUrl = new URL(request.url);
    innerUrl.pathname = scopedReview.apiPath;
    const headers = new Headers(request.headers);
    headers.delete("x-nib-auth-subject");
    const response = await stubForTenant(env, tenantId).fetch(
      new Request(innerUrl, { method: request.method, headers, body: request.body }),
    );
    return tenantScopedReviewApiResponse(response, scopedReview.apiPrefix, url.protocol === "https:");
  }
  if (scopedReview?.kind === "attachment" && request.method === "GET") {
    trustedTenantId(scopedReview.tenantId);
    return attachmentResponse(scopedReview.attachmentId, request, env, false);
  }
  if (url.pathname === "/.well-known/apple-app-site-association" || url.pathname === "/apple-app-site-association") {
    return json({ applinks: { apps: [], details: [{ appID: "2AS3V73632.com.douglance.nib", paths: ["/r/*"] }] } });
  }
  if (url.pathname.startsWith("/r/") && request.method === "GET") {
    return requestPage(url.pathname.split("/")[2] ?? "", url.origin);
  }
  if (!trustedAuth && isLegacyAuthRoute(url.pathname)) {
    return json({
      error: "Legacy authentication has been retired",
      code: "AUTH_MIGRATION_REQUIRED",
      login: "https://app.nibtool.com/signin",
    }, 410);
  }
  const stub = stubForTenant(env, tenant);
  const auth = trustedAuth ?? null;
  if (url.pathname.startsWith("/attachments/") && request.method === "GET") {
    return attachmentResponse(url.pathname.split("/")[2] ?? "", request, env, Boolean(auth));
  }
  if (!auth) return unauthorized();
  const headers = new Headers(request.headers);
  headers.set("x-nib-auth-subject", auth.subject);
  return stub.fetch(new Request(request, { headers }));
}

export class NibRequestHub extends DurableObject<Env> {
  private sockets = new Set<WebSocket>();
  private apns: ApnsClient | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/")) {
      return this.hostedCore().fetch(request, {
        subject: request.headers.get("x-nib-auth-subject"),
        origin: url.origin
      });
    }
    if (url.pathname === "/api/projects" && request.method === "GET") {
      return json({ projects: [] });
    }
    if (url.pathname === "/api/activity" && request.method === "GET") {
      return json([]);
    }
    if (url.pathname === "/api/waiting" && request.method === "GET") {
      return json([]);
    }
    if (url.pathname === "/api/devices") {
      if (request.method === "GET") return json({ devices: await this.listDevices() });
      if (request.method === "POST") {
        return this.registerDevice(
          await request.json<JsonObject>(),
          request.headers.get("x-nib-auth-subject") || "unknown"
        );
      }
    }
    if (url.pathname === "/api/notifications/status" && request.method === "GET") {
      const devices = await this.listDevices();
      const apns = this.apnsClient().configuration();
      const apnsDevices = devices.filter((device) => device.pushKind === "apns");
      const apnsLastError = apnsDevices.find((device) => device.lastError)?.lastError || null;
      const topics = [...new Set(apnsDevices.map((device) => device.apnsTopic).filter(Boolean))];
      return json({
        subscriptionCount: 0,
        deviceCount: devices.length,
        webPushDeviceCount: 0,
        apnsDeviceCount: apnsDevices.length,
        apnsHealthyDeviceCount: apnsDevices.filter((device) => !device.lastError).length,
        apnsLastError,
        apnsConfigured: apns.configured,
        apnsEnvironment: apns.environment,
        apnsTopic: topics.length === 1 ? topics[0] : null,
        apnsKeyConfigured: apns.keyConfigured,
        apnsKeyReadable: apns.keyReadable,
        apnsMissing: apns.missing,
        apnsIssues: apnsLastError ? [apnsLastError] : [],
        webReady: false,
        nativeReady: apns.configured && apnsDevices.length > 0 && !apnsLastError
      });
    }
    if (url.pathname === "/api/notifications/test" && request.method === "POST") {
      const results = await this.deliverApns({
        title: "Nib notifications are ready",
        body: "This device can receive Nib Cloud requests.",
        category: "NIB_OPEN",
      });
      return json({
        sent: results.filter((result) => result.ok).length,
        attempted: results.length,
        errors: results.filter((result) => !result.ok).map((result) => result.error),
        requestId: null,
        feedbackId: null,
        type: "test"
      });
    }
    if (/^\/api\/feedback\/[^/]+\/notification-click$/.test(url.pathname) && request.method === "POST") {
      return json({ recorded: true });
    }
    if (url.pathname === "/api/requests/socket") return this.openSocket(request);
    if (url.pathname === "/api/requests") {
      if (request.method === "GET") return json(await this.list());
      if (request.method === "POST") return json(await this.create(await request.json<JsonObject>()), 201);
    }
    const match = url.pathname.match(/^\/api\/requests\/([^/]+)(?:\/(respond|publish|attachments|response-attachments|notification-click))?$/);
    if (!match) return json({ error: "Not found" }, 404);
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (!action && request.method === "GET") return this.itemResponse(id);
    if (!action && request.method === "PATCH") return this.patch(id, await request.json<JsonObject>());
    if (action === "publish" && request.method === "POST") {
      return this.publish(id, request.headers.get("x-nib-auth-subject") || "legacy-publisher");
    }
    if (action === "respond" && request.method === "POST") return this.respond(id, await request.json<JsonObject>());
    if ((action === "attachments" || action === "response-attachments") && request.method === "POST") {
      return this.attach(id, request, action === "response-attachments");
    }
    if (action === "notification-click" && request.method === "POST") {
      return this.patch(id, { viewed: true, notificationClicked: true });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  private async list(): Promise<RequestRecord[]> {
    const stored = await this.ctx.storage.list<RequestRecord>({ prefix: "request:" });
    return [...stored.entries()]
      .filter(([key]) => isTopLevelRequestStorageKey(key))
      .map(([, item]) => item)
      .filter((item) => item.kind !== "visual-review" || item.publishedAt)
      .sort(compareRecordsByRecency);
  }

  private async get(id: string): Promise<RequestRecord | undefined> {
    return this.ctx.storage.get<RequestRecord>(`request:${id}`);
  }

  private async put(item: RequestRecord): Promise<void> {
    await this.ctx.storage.put(`request:${item.id}`, item);
  }

  private async itemResponse(id: string): Promise<Response> {
    const item = await this.get(id);
    return item ? json(item) : json({ error: "Request not found" }, 404);
  }

  private async listDevices(): Promise<DeviceRecord[]> {
    const stored = await this.ctx.storage.list<DeviceRecord>({ prefix: "device:" });
    return [...stored.values()].sort(compareRecordsByRecency);
  }

  private async registerDevice(input: JsonObject, authSubject: string): Promise<Response> {
    const token = text(input.token);
    const platform = normalizedPlatform(input.platform);
    if (!token) return json({ error: "Device token is required" }, 400);
    if (!["ios", "visionos", "watchos", "macos"].includes(platform)) {
      return json({ error: "Unsupported device platform" }, 400);
    }
    const key = `device:${await sha256(`${platform}:${token}`)}`;
    const previous = await this.ctx.storage.get<DeviceRecord>(key);
    const device: DeviceRecord = {
      id: previous?.id || crypto.randomUUID(),
      name: text(input.name).slice(0, 120) || "Nib device",
      platform,
      pushKind: text(input.pushKind) || "apns",
      token,
      apnsTopic: nullableText(input.apnsTopic),
      capabilities: Array.isArray(input.capabilities)
        ? [...new Set(input.capabilities.map(text).filter(Boolean))].slice(0, 32)
        : [],
      lastSuccessAt: previous?.lastSuccessAt || null,
      lastError: previous?.lastError || null,
      updatedAt: new Date().toISOString(),
      authSubject
    };
    await this.ctx.storage.put(key, device);
    return json(device, previous ? 200 : 201);
  }

  private async create(input: JsonObject): Promise<RequestRecord> {
    const now = new Date().toISOString();
    const prompt = text(input.prompt) || text(input.title) || "Human input requested";
    const choices = Array.isArray(input.choices) ? input.choices.map(text).filter(Boolean) : [];
    const kind = text(input.kind) || (choices.length ? "choice" : "question");
    const item: RequestRecord = {
      id: crypto.randomUUID(),
      kind,
      title: text(input.title) || prompt,
      prompt,
      body: nullableText(input.body),
      context: nullableText(input.context),
      choices,
      allowText: input.allowText !== false,
      target: object(input.target),
      status: "open",
      priority: input.priority === "low" || input.priority === "high" ? input.priority : "normal",
      source: nullableText(input.source),
      createdAt: now,
      updatedAt: now,
      viewedAt: null,
      answeredAt: null,
      actedAt: null,
      resolvedAt: null,
      expiresAt: nullableText(input.expiresAt),
      publishedAt: kind === "visual-review" ? null : now,
      notifiedAt: null,
      notificationClickedAt: null,
      staleReason: null,
      attachments: [],
      responses: [],
      metadata: object(input.metadata)
    };
    await this.put(item);
    if (item.publishedAt) {
      this.broadcast("created", item);
      await this.notifyRequest(item);
    }
    return item;
  }

  private async patch(id: string, input: JsonObject): Promise<Response> {
    const item = await this.get(id);
    if (!item) return json({ error: "Request not found" }, 404);
    const now = new Date().toISOString();
    if (input.metadata && !item.publishedAt) item.metadata = { ...item.metadata, ...object(input.metadata) };
    if (typeof input.status === "string") item.status = input.status;
    if (input.viewed === true) {
      item.viewedAt ??= now;
      if (item.status === "open") item.status = "viewed";
    }
    if (input.notificationClicked === true) item.notificationClickedAt ??= now;
    item.updatedAt = now;
    await this.put(item);
    if (item.publishedAt) this.broadcast("updated", item);
    return json(item);
  }

  private async attach(id: string, request: Request, responseAttachment: boolean): Promise<Response> {
    const item = await this.get(id);
    if (!item) return json({ error: "Request not found" }, 404);
    if (item.publishedAt && !responseAttachment) return json({ error: "Visual review is already published" }, 409);
    if (responseAttachment && (!item.publishedAt || item.responses.length)) {
      return json({ error: "Response attachments require a published unanswered review" }, 409);
    }
    const requestType = (request.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    let name: string;
    let contentType: string;
    let metadata: JsonObject;
    let bytes: ArrayBuffer;
    if (requestType === "application/json") {
      const input = await request.json<JsonObject>();
      name = text(input.name) || "attachment";
      contentType = text(input.contentType) || "application/octet-stream";
      metadata = object(input.metadata);
      const encoded = text(input.contentBase64);
      if (!encoded) return json({ error: "contentBase64 is required" }, 400);
      bytes = decodeBase64(encoded);
    } else {
      name = request.headers.get("x-nib-filename") || "attachment";
      contentType = requestType;
      metadata = parseObject(request.headers.get("x-nib-metadata"));
      bytes = await request.arrayBuffer();
    }
    if (responseAttachment) metadata.role = "response";
    if (!bytes.byteLength) return json({ error: "Attachment is empty" }, 400);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return json({ error: "Attachment exceeds 96 MiB" }, 413);
    const attachmentId = crypto.randomUUID();
    const objectKey = `attachments/${attachmentId}`;
    const mediaToken = randomToken("media");
    await this.env.MEDIA.put(objectKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { accessHash: await sha256(mediaToken) }
    });
    const attachment: RequestAttachment = {
      id: attachmentId,
      requestId: id,
      name: safeName(name),
      type: attachmentType(contentType),
      contentType,
      bytes: bytes.byteLength,
      url: `/attachments/${attachmentId}?access=${encodeURIComponent(mediaToken)}`,
      createdAt: new Date().toISOString(),
      metadata: { ...metadata, objectKey }
    };
    item.attachments.unshift(attachment);
    item.updatedAt = attachment.createdAt;
    await Promise.all([
      this.put(item),
      this.ctx.storage.put(`attachment:${attachmentId}`, attachment)
    ]);
    return json(attachment, 201);
  }

  private async publish(id: string, subject: string): Promise<Response> {
    const item = await this.get(id);
    if (!item) return json({ error: "Request not found" }, 404);
    if (item.publishedAt) {
      return json({ ...item, reviewLink: await this.legacyReviewLink(item, subject) });
    }
    if (item.kind !== "visual-review") return json({ error: "Only visual reviews require publishing" }, 400);
    const contract = text(item.metadata.contract);
    if (contract === "nib.visual-review/v1") {
      const preview = item.attachments.some((entry) => entry.contentType.startsWith("image/") && entry.metadata.role === "preview");
      const canonical = item.attachments.some((entry) => entry.contentType === "application/x-nib" && entry.metadata.role === "canonical");
      if (!preview || !canonical) return json({ error: "Image review requires preview and canonical attachments" }, 400);
    } else if (contract === "nib.review/v2") {
      const primaryId = text(object(item.metadata.subject).primary && object(object(item.metadata.subject).primary).attachmentId);
      if (!primaryId || !item.attachments.some((entry) => entry.id === primaryId)) {
        return json({ error: "Review v2 requires a valid primary attachment" }, 400);
      }
    } else {
      return json({ error: "Unsupported visual review contract" }, 400);
    }
    item.publishedAt = new Date().toISOString();
    item.updatedAt = item.publishedAt;
    await this.put(item);
    this.broadcast("published", item);
    await this.notifyRequest(item);
    return json({ ...item, reviewLink: await this.legacyReviewLink(item, subject) });
  }

  private async legacyReviewLink(item: RequestRecord, subject: string): Promise<string> {
    const id = item.id;
    const expiresAt = new Date(
      new Date(item.publishedAt || item.updatedAt).getTime() + 14 * 24 * 60 * 60 * 1000
    ).toISOString();
    const response = await this.hostedCore().createCapability(
      id,
      {
        scopes: ["view", "comment", "decide"],
        expiresAt,
        name: "Default review link"
      },
      {
        idempotencyKey: `legacy-publish-review-link:${id}`,
        subject
      }
    );
    if (!response.ok) return `/r/${encodeURIComponent(id)}`;
    const body = await response.json<{ link?: string }>();
    return body.link || `/r/${encodeURIComponent(id)}`;
  }

  private async respond(id: string, input: JsonObject): Promise<Response> {
    const item = await this.get(id);
    if (!item) return json({ error: "Request not found" }, 404);
    if (item.responses.length) return json({ error: "Request already has a response" }, 409);
    if (item.kind === "visual-review" && !item.publishedAt) return json({ error: "Visual review is not published" }, 409);
    const now = new Date().toISOString();
    const decision = text(input.decision) || text(input.choice);
    const comment = text(input.comment) || text(input.text);
    const visualData = item.kind === "visual-review" ? {
      contract: "nib.review-response/v1",
      decision: decision || "comment",
      comment: comment || null,
      annotations: Array.isArray(input.annotations) ? input.annotations : []
    } : null;
    const responseAttachments = item.attachments.filter((entry) => entry.metadata.role === "response");
    const response: RequestResponse = {
      id: crypto.randomUUID(),
      kind: visualData ? "visual-review" : (decision ? "choice" : "text"),
      text: comment || decision,
      choice: decision || undefined,
      choiceIndex: typeof input.choiceIndex === "number" ? input.choiceIndex : undefined,
      data: visualData,
      deviceId: text(input.deviceId) || undefined,
      attachments: responseAttachments.length ? responseAttachments : undefined,
      transcript: input.transcript && Object.keys(object(input.transcript)).length ? object(input.transcript) : undefined,
      createdAt: now
    };
    item.responses = [response];
    item.status = input.acted === true ? "acted" : "answered";
    item.answeredAt = now;
    item.actedAt = input.acted === true ? now : null;
    item.updatedAt = now;
    await this.put(item);
    this.broadcast("responded", item);
    return json(item);
  }

  private openSocket(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "Expected WebSocket" }, 426);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    server.send(JSON.stringify({ type: "ready" }));
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(action: string, request: RequestRecord): void {
    const message = JSON.stringify({ type: "request", action, request });
    for (const socket of this.sockets) {
      try {
        socket.send(message);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  private apnsClient(): ApnsClient {
    this.apns ??= new ApnsClient(this.env);
    return this.apns;
  }

  private async notifyRequest(item: RequestRecord): Promise<void> {
    const results = await this.deliverApns({
      title: item.title,
      body: item.prompt,
      category: notificationCategory(item),
      requestId: item.id,
    });
    if (results.some((result) => result.ok)) {
      item.notifiedAt = new Date().toISOString();
      item.updatedAt = item.notifiedAt;
      await this.put(item);
    }
  }

  private async deliverApns(message: ApnsMessage): Promise<Array<{ ok: boolean; error: string | null }>> {
    const devices = (await this.listDevices()).filter((device) => device.pushKind === "apns");
    const results = await Promise.all(devices.map(async (device) => {
      const result = await this.apnsClient().send(device, message);
      device.lastSuccessAt = result.ok ? new Date().toISOString() : device.lastSuccessAt;
      device.lastError = result.error;
      device.updatedAt = new Date().toISOString();
      await this.ctx.storage.put(`device:${await sha256(`${device.platform}:${device.token}`)}`, device);
      return { ok: result.ok, error: result.error };
    }));
    return results;
  }

  private hostedCore(): HostedRequestCoreService {
    return new HostedRequestCoreService(
      new DurableObjectKeyValueStore(this.ctx.storage),
      new R2MediaStore(this.env.MEDIA),
      () => new Date(),
      {
        dispatch: async (delivery) => {
          const response = await fetch(delivery.url, {
            method: "POST",
            headers: delivery.headers,
            body: JSON.stringify({ event: delivery.event, request: delivery.request })
          });
          return { ok: response.ok, status: response.status };
        },
        sign: this.env.NIB_CONTINUATION_HMAC_SECRET
          ? async (delivery) => hmacSha256(this.env.NIB_CONTINUATION_HMAC_SECRET || "", JSON.stringify(delivery.event))
          : undefined
      }
    );
  }
}

class DurableObjectKeyValueStore implements KeyValueStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(key);
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.storage.put(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  async list<T>(prefix: string): Promise<Map<string, T>> {
    return this.storage.list<T>({ prefix });
  }
}

async function attachmentResponse(id: string, request: Request, env: Env, authorized: boolean): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Attachment not found" }, 404);
  const object = await env.MEDIA.get(`attachments/${id}`);
  if (!object) return json({ error: "Attachment not found" }, 404);
  const access = new URL(request.url).searchParams.get("access") || "";
  const capabilityAuthorized = Boolean(
    access && object.customMetadata?.accessHash && constantTimeEqual(await sha256(access), object.customMetadata.accessHash)
  );
  if (!authorized && !capabilityAuthorized) return unauthorized();
  const headers = new Headers(corsHeaders());
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=300");
  return new Response(object.body, { headers });
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer realm=\"nib-global\"" });
}

function normalizedPlatform(value: unknown): string {
  const platform = text(value).toLowerCase();
  return ["cli", "macos", "ios", "visionos", "watchos", "cloudflare-codemode"].includes(platform)
    ? platform
    : "unknown";
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${prefix}_${encoded}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

function requestPage(id: string, origin: string, apiPrefix = "/v1"): Response {
  return new Response(reviewPageHtml(id, origin, apiPrefix), { headers: reviewPageHeaders() });
}

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { ...corsHeaders(), "cache-control": "no-store", ...extra } });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
    "access-control-allow-headers": "accept,authorization,content-type,idempotency-key,last-event-id,x-nib-capability,x-nib-filename,x-nib-metadata"
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function parseObject(value: string | null): JsonObject {
  if (!value) return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}

function safeName(value: string): string {
  return value.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "attachment";
}

function attachmentType(contentType: string): RequestAttachment["type"] {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf" || contentType.startsWith("text/")) return "document";
  return "file";
}

function notificationCategory(item: RequestRecord): string {
  const choices = item.choices.map((choice) => choice.toLowerCase());
  const key = choices.join("|");
  const known: Record<string, string> = {
    "ship|hold|revise": "NIB_SHIP_HOLD_REVISE",
    "approve|hold": "NIB_APPROVE_HOLD",
    "approve|reject": "NIB_APPROVE_REJECT",
    "allow|deny": "NIB_ALLOW_DENY",
    "yes|no": "NIB_YES_NO",
    "ship|hold": "NIB_SHIP_HOLD",
    "use it|revise": "NIB_USE_REVISE",
  };
  if (known[key]) return known[key];
  if (item.choices.length) return "NIB_CHOICE";
  return item.allowText ? "NIB_TEXT" : "NIB_OPEN";
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
