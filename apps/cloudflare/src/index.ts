import { DurableObject } from "cloudflare:workers";

interface Env {
  REQUESTS: DurableObjectNamespace<NibRequestHub>;
  MEDIA: R2Bucket;
  NIB_AUTH_TOKEN?: string;
  NIB_TENANT_ID?: string;
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

interface AuthTokenRecord {
  id: string;
  name: string;
  platform: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
}

interface PairingRecord {
  id: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
}

interface RateLimitRecord {
  windowStartedAt: number;
  attempts: number;
}

interface AuthContext {
  kind: "bootstrap" | "token";
  subject: string;
  name: string;
  platform: string;
  scopes: string[];
  tokenHash?: string;
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
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "nib-global", durable: true, media: "r2" });
    }
    if (url.pathname === "/.well-known/apple-app-site-association" || url.pathname === "/apple-app-site-association") {
      return json({ applinks: { apps: [], details: [{ appID: "2AS3V73632.com.douglance.nib", paths: ["/r/*"] }] } });
    }
    if (url.pathname.startsWith("/r/") && request.method === "GET") {
      return requestPage(url.pathname.split("/")[2] ?? "", url.origin);
    }
    const tenant = env.NIB_TENANT_ID?.trim() || "primary";
    const stub = env.REQUESTS.get(env.REQUESTS.idFromName(tenant));

    if (url.pathname === "/api/auth/exchange" && request.method === "POST") {
      if (!bootstrapAuthorized(request, env)) return unauthorized();
      return stub.fetch(request);
    }
    if (url.pathname === "/api/auth/pairings/redeem" && request.method === "POST") {
      const headers = new Headers(request.headers);
      headers.set("x-nib-client-key", await sha256(request.headers.get("cf-connecting-ip") || "unknown"));
      return stub.fetch(new Request(request, { headers }));
    }

    const auth = await authenticate(request, env, stub);
    if (url.pathname.startsWith("/attachments/") && request.method === "GET") {
      return attachmentResponse(url.pathname.split("/")[2] ?? "", request, env, Boolean(auth));
    }
    if (!auth) return unauthorized();
    const requiredScope = scopeFor(request.method, url.pathname);
    if (requiredScope && !hasScope(auth, requiredScope)) return forbidden(requiredScope);

    if (url.pathname === "/api/auth/status" && request.method === "GET") {
      return json({
        authenticated: true,
        kind: auth.kind,
        subject: auth.subject,
        name: auth.name,
        platform: auth.platform,
        scopes: auth.scopes
      });
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      if (auth.kind === "bootstrap" || !auth.tokenHash) return json({ revoked: false, bootstrap: true });
      return stub.fetch(new Request(new URL("/internal/auth/revoke", request.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenHash: auth.tokenHash })
      }));
    }
    if (url.pathname === "/api/auth/pairings" && request.method === "POST") {
      const headers = new Headers(request.headers);
      headers.set("x-nib-auth-subject", auth.subject);
      return stub.fetch(new Request(request, { headers }));
    }
    const headers = new Headers(request.headers);
    headers.set("x-nib-auth-subject", auth.subject);
    return stub.fetch(new Request(request, { headers }));
  }
};

export class NibRequestHub extends DurableObject<Env> {
  private sockets = new Set<WebSocket>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/auth/verify" && request.method === "POST") {
      return this.verifyToken(await request.json<JsonObject>());
    }
    if (url.pathname === "/internal/auth/revoke" && request.method === "POST") {
      return this.revokeToken(await request.json<JsonObject>());
    }
    if (url.pathname === "/api/auth/exchange" && request.method === "POST") {
      return this.issueToken(await request.json<JsonObject>());
    }
    if (url.pathname === "/api/auth/pairings" && request.method === "POST") {
      return this.createPairing(request.headers.get("x-nib-auth-subject") || "bootstrap");
    }
    if (url.pathname === "/api/auth/pairings/redeem" && request.method === "POST") {
      return this.redeemPairing(await request.json<JsonObject>(), request.headers.get("x-nib-client-key") || "unknown");
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
      return json({
        subscriptionCount: 0,
        deviceCount: devices.length,
        webPushDeviceCount: 0,
        apnsDeviceCount: devices.filter((device) => device.pushKind === "apns").length,
        apnsHealthyDeviceCount: devices.filter((device) => device.pushKind === "apns" && !device.lastError).length,
        apnsLastError: null,
        apnsConfigured: false,
        apnsEnvironment: null,
        apnsTopic: null,
        apnsKeyConfigured: false,
        apnsKeyReadable: false,
        apnsMissing: ["APNs delivery is not configured on nib-global"],
        apnsIssues: [],
        webReady: false,
        nativeReady: false
      });
    }
    if (url.pathname === "/api/notifications/test" && request.method === "POST") {
      return json({ sent: 0, requestId: null, feedbackId: null, type: "test" });
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
    if (action === "publish" && request.method === "POST") return this.publish(id);
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
    return [...stored.values()]
      .filter((item) => item.kind !== "visual-review" || item.publishedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async get(id: string): Promise<RequestRecord | undefined> {
    return this.ctx.storage.get<RequestRecord>(`request:${id}`);
  }

  private async put(item: RequestRecord): Promise<void> {
    await this.ctx.storage.put(`request:${item.id}`, item);
  }

  private async issueToken(input: JsonObject): Promise<Response> {
    const name = text(input.name).slice(0, 120) || "Nib client";
    const platform = normalizedPlatform(input.platform);
    const requestedScopes = normalizedScopes(input.scopes);
    const issued = await this.createToken(name, platform, requestedScopes);
    await this.revokeMatchingTokens(name, platform, issued.id as string);
    return json(issued, 201);
  }

  private async createToken(name: string, platform: string, scopes: string[]): Promise<JsonObject> {
    const token = randomToken("nib");
    const tokenHash = await sha256(token);
    const now = new Date().toISOString();
    const record: AuthTokenRecord = {
      id: crypto.randomUUID(),
      name,
      platform,
      scopes,
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null
    };
    await this.ctx.storage.put(`auth:token:${tokenHash}`, record);
    return { token, tokenType: "Bearer", ...record };
  }

  private async verifyToken(input: JsonObject): Promise<Response> {
    const tokenHash = text(input.tokenHash);
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return json({ authenticated: false }, 401);
    const record = await this.ctx.storage.get<AuthTokenRecord>(`auth:token:${tokenHash}`);
    if (!record || record.revokedAt) return json({ authenticated: false }, 401);
    const now = new Date();
    if (now.getTime() - new Date(record.lastUsedAt).getTime() >= 60 * 60 * 1000) {
      record.lastUsedAt = now.toISOString();
      await this.ctx.storage.put(`auth:token:${tokenHash}`, record);
    }
    return json({ authenticated: true, tokenHash, ...record });
  }

  private async revokeToken(input: JsonObject): Promise<Response> {
    const tokenHash = text(input.tokenHash);
    const key = `auth:token:${tokenHash}`;
    const record = await this.ctx.storage.get<AuthTokenRecord>(key);
    if (!record) return json({ revoked: true });
    record.revokedAt ??= new Date().toISOString();
    await this.ctx.storage.put(key, record);
    return json({ revoked: true, id: record.id });
  }

  private async createPairing(createdBy: string): Promise<Response> {
    const code = randomToken("pair");
    const codeHash = await sha256(code);
    const createdAt = new Date();
    const pairing: PairingRecord = {
      id: crypto.randomUUID(),
      createdBy,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 10 * 60 * 1000).toISOString(),
      redeemedAt: null
    };
    await this.ctx.storage.put(`auth:pairing:${codeHash}`, pairing);
    return json({
      code,
      expiresAt: pairing.expiresAt,
      url: `nib://auth/pair?server=${encodeURIComponent("https://nib-global.doug-lance.workers.dev")}&code=${encodeURIComponent(code)}`
    }, 201);
  }

  private async redeemPairing(input: JsonObject, clientKey: string): Promise<Response> {
    if (!await this.allowPairingAttempt(clientKey)) {
      return json({ error: "Too many pairing attempts" }, 429, { "retry-after": "300" });
    }
    const code = text(input.code);
    if (!/^pair_[A-Za-z0-9_-]{40,80}$/.test(code)) return json({ error: "Invalid or expired pairing code" }, 401);
    const key = `auth:pairing:${await sha256(code)}`;
    const pairing = await this.ctx.storage.get<PairingRecord>(key);
    if (!pairing || pairing.redeemedAt || new Date(pairing.expiresAt).getTime() <= Date.now()) {
      return json({ error: "Invalid or expired pairing code" }, 401);
    }
    pairing.redeemedAt = new Date().toISOString();
    await this.ctx.storage.put(key, pairing);
    const platform = normalizedPlatform(input.platform);
    const scopes = platform === "cloudflare-codemode"
      ? ["requests:read", "requests:write"]
      : DEFAULT_SCOPES;
    const name = text(input.name).slice(0, 120) || "Nib device";
    const issued = await this.createToken(
      name,
      platform,
      scopes
    );
    await this.revokeMatchingTokens(name, platform, issued.id as string);
    return json(issued, 201);
  }

  private async revokeMatchingTokens(name: string, platform: string, exceptID: string): Promise<void> {
    const stored = await this.ctx.storage.list<AuthTokenRecord>({ prefix: "auth:token:" });
    const updates: Promise<void>[] = [];
    for (const [key, record] of stored) {
      if (record.id === exceptID || record.revokedAt || record.name !== name || record.platform !== platform) continue;
      record.revokedAt = new Date().toISOString();
      updates.push(this.ctx.storage.put(key, record));
    }
    await Promise.all(updates);
  }

  private async allowPairingAttempt(clientKey: string): Promise<boolean> {
    const key = `auth:rate:${clientKey}`;
    const now = Date.now();
    const current = await this.ctx.storage.get<RateLimitRecord>(key);
    const record = !current || now - current.windowStartedAt >= 5 * 60 * 1000
      ? { windowStartedAt: now, attempts: 1 }
      : { ...current, attempts: current.attempts + 1 };
    await this.ctx.storage.put(key, record);
    return record.attempts <= 10;
  }

  private async itemResponse(id: string): Promise<Response> {
    const item = await this.get(id);
    return item ? json(item) : json({ error: "Request not found" }, 404);
  }

  private async listDevices(): Promise<DeviceRecord[]> {
    const stored = await this.ctx.storage.list<DeviceRecord>({ prefix: "device:" });
    return [...stored.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
    if (item.publishedAt) this.broadcast("created", item);
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

  private async publish(id: string): Promise<Response> {
    const item = await this.get(id);
    if (!item) return json({ error: "Request not found" }, 404);
    if (item.publishedAt) return json(item);
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
    return json(item);
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

function bootstrapAuthorized(request: Request, env: Env): boolean {
  if (!env.NIB_AUTH_TOKEN) return ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname);
  const supplied = bearerToken(request);
  return constantTimeEqual(supplied, env.NIB_AUTH_TOKEN);
}

async function authenticate(
  request: Request,
  env: Env,
  stub: DurableObjectStub<NibRequestHub>
): Promise<AuthContext | null> {
  const supplied = bearerToken(request);
  if (!supplied) return null;
  if (env.NIB_AUTH_TOKEN && constantTimeEqual(supplied, env.NIB_AUTH_TOKEN)) {
    return { kind: "bootstrap", subject: "bootstrap", name: "Bootstrap administrator", platform: "worker", scopes: ["*"] };
  }
  const tokenHash = await sha256(supplied);
  const response = await stub.fetch(new Request(new URL("/internal/auth/verify", request.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash })
  }));
  if (!response.ok) return null;
  const record = await response.json<AuthTokenRecord & { authenticated: boolean }>();
  if (!record.authenticated) return null;
  return {
    kind: "token",
    subject: record.id,
    name: record.name,
    platform: record.platform,
    scopes: record.scopes,
    tokenHash
  };
}

function bearerToken(request: Request): string {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer realm=\"nib-global\"" });
}

function forbidden(scope: string): Response {
  return json({ error: "Forbidden", requiredScope: scope }, 403);
}

const DEFAULT_SCOPES = ["requests:read", "requests:write", "auth:pair"];

function normalizedScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SCOPES];
  const allowed = new Set(["requests:read", "requests:write", "auth:pair"]);
  const scopes = value.map(text).filter((scope) => allowed.has(scope));
  return scopes.length ? [...new Set(scopes)] : [...DEFAULT_SCOPES];
}

function normalizedPlatform(value: unknown): string {
  const platform = text(value).toLowerCase();
  return ["cli", "macos", "ios", "visionos", "watchos", "cloudflare-codemode"].includes(platform)
    ? platform
    : "unknown";
}

function scopeFor(method: string, path: string): string | null {
  if (path === "/api/auth/pairings") return "auth:pair";
  if (path.startsWith("/api/auth/")) return null;
  if (path.startsWith("/api/requests")) return method === "GET" ? "requests:read" : "requests:write";
  return method === "GET" ? "requests:read" : "requests:write";
}

function hasScope(auth: AuthContext, scope: string): boolean {
  return auth.scopes.includes("*") || auth.scopes.includes(scope);
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

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

function requestPage(id: string, origin: string): Response {
  const native = `nib://request/${encodeURIComponent(id)}?server=${encodeURIComponent(origin)}`;
  const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>Nib review</title><style>body{font:16px system-ui;max-width:42rem;margin:10vh auto;padding:2rem;color:#171717}a{display:inline-block;padding:.8rem 1rem;background:#18181b;color:white;border-radius:.6rem;text-decoration:none}</style><h1>Nib review</h1><p>Open this request in the installed Nib app.</p><a href="${native}">Open Nib</a>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...corsHeaders() } });
}

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { ...corsHeaders(), "cache-control": "no-store", ...extra } });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-nib-filename,x-nib-metadata"
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

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
