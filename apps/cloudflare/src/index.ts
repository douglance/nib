import { DurableObject } from "cloudflare:workers";
import { apnsReadiness, sendApnsFanout, type ApnsPayload } from "./apns";
import { accountInboxName, canonicalAccountId } from "./account-inbox";
import { NibFileBackend } from "./nib-files";
import { purgeReviewAccount } from "./account-data";
import { commitFirstResponse, responseChoiceValue, visualResponseError } from "./response-coordinator";
import { isPublishedVisualReview, parseReviewRoute, publicAttachmentUrl, publicResponseUrl, publicReviewRecord, reviewPage, reviewPath } from "./review-page";
import { acceptanceNotification, acceptanceNotificationPayload } from "./acceptance-notifications";

interface Env {
  REQUESTS: DurableObjectNamespace<AccountReviewHub>;
  MEDIA: R2Bucket;
  NIB_APNS_TEAM_ID?: string;
  NIB_APNS_KEY_ID?: string;
  NIB_APNS_PRIVATE_KEY?: string;
  NIB_ACCEPTANCE_ORIGIN?: string;
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
  idempotencyKey?: string;
  createdAt: string;
}

interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  pushKind: string;
  token: string;
  apnsTopic: string;
  apnsEnvironment: "sandbox" | "production";
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
    const reviewRoute = parseReviewRoute(url.pathname);
    if (reviewRoute) {
      if (reviewRoute.action === "page" && request.method === "GET") {
        return reviewPage(reviewRoute.accountId, reviewRoute.requestId);
      }
      if (reviewRoute.action === "attachment" && request.method === "GET") {
        if (!reviewRoute.attachmentId) return json({ error: "Attachment not found" }, 404);
        return attachmentResponse(
          reviewRoute.accountId,
          reviewRoute.attachmentId,
          env,
          url.searchParams.get("access") || "",
          true
        );
      }
      if (reviewRoute.action === "data" && request.method === "GET") {
        const item = await fetchAccountRequest(env, reviewRoute.accountId, reviewRoute.requestId, url.origin);
        return item ? json(publicReviewRecord(item, reviewRoute.accountId)) : json({ error: "Request not found" }, 404);
      }
      if (reviewRoute.action === "respond" && request.method === "POST") {
        return respondPublicReview(env, reviewRoute.accountId, reviewRoute.requestId, request, url.origin);
      }
      return json({ error: "Method not allowed" }, 405);
    }
    if (url.pathname.startsWith("/r/") && request.method === "GET") {
      return json({ error: "Not found" }, 404);
    }
    const accountId = trustedAccountId(request);
    if (!accountId) return unauthorized();
    const stub = env.REQUESTS.get(env.REQUESTS.idFromName(accountInboxName(accountId)));
    if (url.pathname.startsWith("/attachments/") && request.method === "GET") {
      return attachmentResponse(accountId, url.pathname.split("/")[2] ?? "", env);
    }
    const headers = new Headers(request.headers);
    headers.set("x-nib-auth-subject", accountId);
    headers.set("x-nib-account-id", accountId);
    return stub.fetch(new Request(request, { headers }));
  }
};

export class AccountReviewHub extends DurableObject<Env> {
  private sockets = new Set<WebSocket>();
  private acceptanceDelivery: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/account" && request.method === "DELETE") {
      const accountId = request.headers.get("x-nib-account-id");
      if (!accountId) return unauthorized();
      return json({ deleted: true, ...(await purgeReviewAccount(
        accountId,
        this.ctx.storage,
        this.env.MEDIA,
      )) });
    }
    if (await this.ctx.storage.get("account:deleted")) {
      return json({ error: "Account deleted" }, 410);
    }
    if (url.pathname === "/api/acceptance-notifications" && request.method === "POST") {
      const input = await request.json();
      const response = this.acceptanceDelivery.then(() => this.acceptanceNotice(input));
      this.acceptanceDelivery = response.then(() => undefined, () => undefined);
      return response;
    }
    if (url.pathname === "/api/nib-files" || url.pathname.startsWith("/api/nib-files/")) {
      const fileResponse = await new NibFileBackend({
        tenantId: request.headers.get("x-nib-account-id") || "invalid",
        storage: this.ctx.storage,
        media: this.env.MEDIA
      }).fetch(request);
      if (fileResponse) return fileResponse;
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
      const readiness = apnsReadiness(this.env);
      const apnsDevices = devices.filter((device) => device.pushKind === "apns");
      return json({
        subscriptionCount: 0,
        deviceCount: devices.length,
        webPushDeviceCount: 0,
        apnsDeviceCount: apnsDevices.length,
        apnsHealthyDeviceCount: apnsDevices.filter((device) => !device.lastError).length,
        apnsLastError: apnsDevices.find((device) => device.lastError)?.lastError || null,
        ...readiness,
        webReady: false,
        nativeReady: readiness.apnsConfigured && apnsDevices.length > 0
      });
    }
    if (url.pathname === "/api/notifications/test" && request.method === "POST") {
      const sent = await this.deliver({
        type: "test",
        title: "Nib notifications are ready",
        body: "This device can receive Nib requests.",
        tag: `test:${crypto.randomUUID()}`
      });
      return json({ sent, requestId: null, feedbackId: null, type: "test" });
    }
    if (/^\/api\/feedback\/[^/]+\/notification-click$/.test(url.pathname) && request.method === "POST") {
      return json({ recorded: true });
    }
    if (url.pathname === "/api/requests/socket") return this.openSocket(request);
    const accountId = request.headers.get("x-nib-account-id") || "invalid";
    if (url.pathname === "/api/requests") {
      if (request.method === "GET") return json(await this.list());
      if (request.method === "POST") return json(await this.create(await request.json<JsonObject>(), url.origin), 201);
    }
    const match = url.pathname.match(/^\/api\/requests\/([^/]+)(?:\/(respond|publish|attachments|response-attachments|notification-click))?$/);
    if (!match) return json({ error: "Not found" }, 404);
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (!action && request.method === "GET") return this.itemResponse(id);
    if (!action && request.method === "PATCH") return this.patch(id, await request.json<JsonObject>());
    if (action === "publish" && request.method === "POST") return this.publish(id, url.origin, accountId);
    if (action === "respond" && request.method === "POST") {
      return this.respond(
        id,
        await request.json<JsonObject>(),
        request.headers.get("idempotency-key") || "",
        url.origin,
        accountId
      );
    }
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

  private async acceptanceNotice(raw: unknown): Promise<Response> {
    let notice;
    try { notice = acceptanceNotification(raw, this.env.NIB_ACCEPTANCE_ORIGIN || "https://nibtool.com"); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid acceptance notification" }, 400); }
    const now = new Date().toISOString();
    const key = `acceptance-delivery:${notice.reviewId}:${notice.state}`;
    const existing = await this.get(notice.reviewId);
    if (existing && existing.kind !== "acceptance-review") return json({ error: "Request id collision" }, 409);
    if (Number(existing?.metadata.acceptanceSequence || 0) > notice.sequence) return json({ delivered: true, stale: true });
    if (await this.ctx.storage.get(key)) return json({ delivered: true, replayed: true });
    const item: RequestRecord = {
      id: notice.reviewId, kind: "acceptance-review", title: notice.title,
      prompt: "Open the exact preview and review the requested behavior.", body: notice.change,
      context: null, choices: [], allowText: false, target: { projectId: notice.projectId },
      status: notice.state === "pending" ? "open" : "resolved", priority: "normal", source: "acceptance",
      createdAt: existing?.createdAt || now, updatedAt: now, viewedAt: existing?.viewedAt || null,
      answeredAt: notice.state === "pending" ? null : now, actedAt: null,
      resolvedAt: notice.state === "pending" ? null : now, expiresAt: notice.expiresAt,
      publishedAt: existing?.publishedAt || now, notifiedAt: existing?.notifiedAt || null,
      notificationClickedAt: existing?.notificationClickedAt || null, staleReason: null,
      attachments: [], responses: [], metadata: { contract: "nib.acceptance/v1", projectId: notice.projectId,
        reviewUrl: notice.reviewUrl, revision: notice.revision, acceptanceState: notice.state, acceptanceSequence: notice.sequence },
    };
    await this.put(item);
    this.broadcast(existing ? "updated" : "created", item);
    const sent = await this.deliver(acceptanceNotificationPayload(notice));
    const devices = await this.listDevices();
    if (sent === 0 && devices.length > 0) return json({ error: "Device delivery needs retry", inboxStored: true }, 503);
    await this.ctx.storage.put(key, { deliveredAt: now, sent });
    return json({ delivered: true, sent, requestId: item.id });
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
    return [...stored.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async registerDevice(input: JsonObject, authSubject: string): Promise<Response> {
    const token = text(input.token);
    const platform = normalizedPlatform(input.platform);
    if (!token) return json({ error: "Device token is required" }, 400);
    if (!["ios", "visionos", "watchos", "macos"].includes(platform)) {
      return json({ error: "Unsupported device platform" }, 400);
    }
    const apnsTopic = text(input.apnsTopic);
    if (!apnsTopic) return json({ error: "APNs topic is required" }, 400);
    const apnsEnvironment = normalizedApnsEnvironment(input.apnsEnvironment);
    if (!apnsEnvironment) return json({ error: "APNs environment must be sandbox or production" }, 400);
    const key = `device:${await sha256(`${platform}:${token}`)}`;
    const previous = await this.ctx.storage.get<DeviceRecord>(key);
    const device: DeviceRecord = {
      id: previous?.id || crypto.randomUUID(),
      name: text(input.name).slice(0, 120) || "Nib device",
      platform,
      pushKind: text(input.pushKind) || "apns",
      token,
      apnsTopic,
      apnsEnvironment,
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

  private async create(input: JsonObject, origin: string): Promise<RequestRecord> {
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
      const sent = await this.deliver(requestNotificationPayload(item, origin));
      if (sent > 0) {
        item.notifiedAt = new Date().toISOString();
        item.updatedAt = item.notifiedAt;
        await this.put(item);
        this.broadcast("updated", item);
      }
    }
    return item;
  }

  private async patch(id: string, input: JsonObject): Promise<Response> {
    const item = await this.get(id);
    if (!item) return json({ error: "Request not found" }, 404);
    if (item.kind === "acceptance-review" && (input.status !== undefined || input.metadata !== undefined)) {
      return json({ error: "Acceptance state is managed by the team review", reviewUrl: item.metadata.reviewUrl }, 409);
    }
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
    if (contentType === "application/pdf" && !hasPdfHeader(bytes)) {
      return json({ error: "PDF attachment is not a PDF file" }, 400);
    }
    const attachmentId = crypto.randomUUID();
    const accountId = request.headers.get("x-nib-account-id");
    if (!accountId) return unauthorized();
    const objectKey = `accounts/${accountId}/attachments/${attachmentId}`;
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

  private async publish(id: string, origin: string, accountId: string): Promise<Response> {
    const item = await this.get(id);
    if (!item) return json({ error: "Request not found" }, 404);
    if (item.publishedAt) return json(item);
    if (item.kind !== "visual-review") return json({ error: "Only visual reviews require publishing" }, 400);
    const contract = text(item.metadata.contract);
    if (contract === "nib.visual-review/v1") {
      const preview = item.attachments.some((entry) => entry.contentType.startsWith("image/") && entry.metadata.role === "preview");
      const canonical = item.attachments.some((entry) => entry.contentType === "application/x-nib" && entry.metadata.role === "canonical");
      if (!preview || !canonical) return json({ error: "Image review requires preview and canonical attachments" }, 400);
    } else if (contract === "nib.review/v2" || contract === "nib.review/v3") {
      const subject = object(item.metadata.subject);
      const primary = object(subject.primary);
      const primaryId = text(primary.attachmentId);
      const attachment = item.attachments.find((entry) => entry.id === primaryId);
      if (text(subject.contract) !== contract || !attachment) {
        return json({ error: `${contract} requires a matching subject and primary attachment` }, 400);
      }
      if (text(primary.kind) === "pdf") {
        const pageCount = primary.pageCount;
        const pages = primary.pages;
        if (contract !== "nib.review/v3" || attachment.contentType !== "application/pdf") {
          return json({ error: "PDF reviews require nib.review/v3 and application/pdf" }, 400);
        }
        if (!Number.isInteger(pageCount) || Number(pageCount) <= 0 || !Array.isArray(pages) || pages.length !== pageCount) {
          return json({ error: "PDF review pages must match a positive pageCount" }, 400);
        }
        if (pages.some((page) => !validPdfPage(object(page)))) {
          return json({ error: "PDF review contains invalid page geometry" }, 400);
        }
      }
    } else {
      return json({ error: "Unsupported visual review contract" }, 400);
    }
    item.publishedAt = new Date().toISOString();
    item.updatedAt = item.publishedAt;
    item.metadata.accountId = accountId;
    item.metadata.reviewUrl = reviewPath(origin, accountId, item.id);
    await this.put(item);
    this.broadcast("published", item);
    const sent = await this.deliver(requestNotificationPayload(item, origin));
    if (sent > 0) {
      item.notifiedAt = new Date().toISOString();
      item.updatedAt = item.notifiedAt;
      await this.put(item);
      this.broadcast("updated", item);
    }
    return json(item);
  }

  private async respond(
    id: string,
    input: JsonObject,
    headerIdempotencyKey: string,
    origin: string,
    accountId: string
  ): Promise<Response> {
    const item = await this.get(id);
    if (!item) return json({ error: "Request not found" }, 404);
    if (item.kind === "acceptance-review") return json({ error: "Open the team review to record an acceptance decision", reviewUrl: item.metadata.reviewUrl }, 409);
    const idempotencyKey = (headerIdempotencyKey || text(input.idempotencyKey)).slice(0, 200);
    if (item.kind === "visual-review" && !item.publishedAt) return json({ error: "Visual review is not published" }, 409);
    const now = new Date().toISOString();
    const decision = responseChoiceValue(
      input,
      item.kind === "visual-review" ? ["approve", "reject"] : item.choices
    );
    const comment = text(input.comment) || text(input.text);
    if (item.kind === "visual-review") {
      const error = visualResponseError(decision, comment);
      if (error) return json({ error }, 400);
    }
    const annotations = Array.isArray(input.annotations) ? input.annotations : [];
    const subject = object(item.metadata.subject);
    const primary = object(subject.primary);
    if (text(primary.kind) === "pdf") {
      const pageCount = Number(primary.pageCount);
      const invalid = annotations.some((annotation) => {
        const pageIndex = object(annotation).pageIndex;
        return !Number.isInteger(pageIndex) || Number(pageIndex) < 0 || Number(pageIndex) >= pageCount;
      });
      if (invalid) return json({ error: "PDF review annotations require an in-range pageIndex anchor" }, 400);
    }
    const visualData = item.kind === "visual-review" ? {
      contract: text(item.metadata.contract).startsWith("nib.review/")
        ? text(item.metadata.contract)
        : "nib.visual-review/v1",
      decision: decision || "comment",
      comment: comment || null,
      annotations
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
      idempotencyKey: idempotencyKey || undefined,
      createdAt: now
    };
    const committed = await commitFirstResponse<RequestResponse, RequestRecord>({
      runTransaction: (callback) => this.ctx.storage.transaction(async (transaction) => callback(transaction)),
      storageKey: `request:${id}`,
      response,
      idempotencyKey,
      acted: input.acted === true,
      now
    });
    if (committed.outcome === "missing") return json({ error: "Request not found" }, 404);
    if (committed.outcome === "conflict") {
      return json({ error: "Request already has a response", request: committed.item }, 409);
    }
    if (committed.outcome === "retry") return json(committed.item);
    const accepted = committed.item;
    this.broadcast("responded", accepted);
    this.scheduleDelivery({
      type: "request-resolved",
      requestId: accepted.id,
      status: accepted.status,
      responseId: response.id,
      tag: `request:${accepted.id}`,
      url: reviewPath(origin, accountId, accepted.id)
    });
    return json(accepted);
  }

  private scheduleDelivery(payload: ApnsPayload): void {
    this.ctx.waitUntil(this.deliver(payload).catch((error: unknown) => {
      console.error("Nib APNs delivery failed", error);
    }));
  }

  private async deliver(payload: ApnsPayload): Promise<number> {
    const devices = (await this.listDevices()).filter((device) => device.pushKind === "apns");
    const results = await sendApnsFanout(this.env, devices, payload);
    const now = new Date().toISOString();
    await Promise.all(devices.map(async (device) => {
      const result = results.find((entry) => entry.deviceId === device.id);
      if (!result) return;
      device.lastSuccessAt = result.sent ? now : device.lastSuccessAt;
      device.lastError = result.error;
      device.updatedAt = now;
      const key = `device:${await sha256(`${device.platform}:${device.token}`)}`;
      if (result.invalidToken) {
        await this.ctx.storage.delete(key);
      } else {
        await this.ctx.storage.put(key, device);
      }
    }));
    return results.filter((result) => result.sent).length;
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

async function fetchAccountRequest(
  env: Env,
  accountId: string,
  requestId: string,
  origin: string
): Promise<RequestRecord | null> {
  const response = await fetchAccountRequestAction(env, accountId, requestId, "", new Request(`${origin}/api/requests/${requestId}`), origin);
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const item = await response.json<RequestRecord>();
  return isPublishedVisualReview(item) ? item : null;
}

function fetchAccountRequestAction(
  env: Env,
  accountId: string,
  requestId: string,
  action: "" | "respond",
  source: Request,
  origin: string
): Promise<Response> {
  const headers = new Headers(source.headers);
  headers.set("x-nib-auth-subject", accountId);
  headers.set("x-nib-account-id", accountId);
  const path = action
    ? `/api/requests/${encodeURIComponent(requestId)}/${action}`
    : `/api/requests/${encodeURIComponent(requestId)}`;
  const forwarded = new Request(`${origin}${path}`, {
    method: source.method,
    headers,
    body: source.body,
    redirect: "manual"
  });
  return env.REQUESTS
    .get(env.REQUESTS.idFromName(accountInboxName(accountId)))
    .fetch(forwarded);
}

async function respondPublicReview(
  env: Env,
  accountId: string,
  requestId: string,
  source: Request,
  origin: string
): Promise<Response> {
  if (!await fetchAccountRequest(env, accountId, requestId, origin)) {
    return json({ error: "Request not found" }, 404);
  }
  const response = await fetchAccountRequestAction(env, accountId, requestId, "respond", source, origin);
  const body = await response.json<JsonObject>().catch(() => null);
  if (!body) return response;
  if (response.ok) return json(publicReviewRecord(body as unknown as RequestRecord, accountId), response.status);
  const request = object(body.request);
  if (request.id) {
    return json({
      error: text(body.error) || "Request already has a response",
      request: publicReviewRecord(request as unknown as RequestRecord, accountId)
    }, response.status);
  }
  return json({ error: text(body.error) || "The response was not accepted" }, response.status);
}

async function attachmentResponse(
  accountId: string,
  id: string,
  env: Env,
  accessToken = "",
  requireAccess = false
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Attachment not found" }, 404);
  const object = await env.MEDIA.get(`accounts/${accountId}/attachments/${id}`);
  if (!object) return json({ error: "Attachment not found" }, 404);
  const expected = object.customMetadata?.accessHash;
  if (requireAccess && (!accessToken || !expected || expected !== await sha256(accessToken))) {
    return json({ error: "Attachment not found" }, 404);
  }
  const headers = new Headers(corsHeaders());
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=300");
  return new Response(object.body, { headers });
}

function trustedAccountId(request: Request): string | null {
  return canonicalAccountId(request.headers.get("x-nib-account-id") ?? "");
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

function normalizedApnsEnvironment(value: unknown): "sandbox" | "production" | null {
  const environment = text(value).toLowerCase();
  return environment === "sandbox" || environment === "production" ? environment : null;
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
function requestNotificationPayload(item: RequestRecord, origin: string): ApnsPayload {
  const rich = item.attachments.find((attachment) => attachment.type === "image" && attachment.url);
  const accountId = text(item.metadata.accountId);
  const reviewUrl = text(item.metadata.reviewUrl)
    || (accountId ? reviewPath(origin, accountId, item.id) : `${origin}/r/${encodeURIComponent(item.id)}`);
  const richURL = rich && accountId
    ? new URL(publicAttachmentUrl(accountId, item.id, rich), origin).toString()
    : null;
  return {
    type: item.kind,
    requestId: item.id,
    title: item.title,
    body: item.body || item.prompt,
    request: item.prompt,
    choices: item.choices,
    allowText: item.allowText,
    projectId: text(item.target.projectId) || undefined,
    projectName: text(item.target.projectName) || undefined,
    url: reviewUrl,
    responseUrl: accountId
      ? publicResponseUrl(origin, accountId, item.id)
      : `${origin}/api/requests/${encodeURIComponent(item.id)}/respond`,
    tag: `request:${item.id}`,
    priority: item.priority,
    createdAt: item.createdAt,
    richAttachment: rich && richURL ? {
      id: rich.id,
      name: rich.name,
      type: rich.type,
      contentType: rich.contentType,
      url: richURL
    } : undefined
  };
}

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { ...corsHeaders(), "cache-control": "no-store", ...extra } });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,idempotency-key,range,x-nib-filename,x-nib-metadata"
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

function hasPdfHeader(value: ArrayBuffer): boolean {
  const bytes = new Uint8Array(value, 0, Math.min(5, value.byteLength));
  return bytes.length === 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

function validPdfPage(page: JsonObject): boolean {
  return typeof page.width === "number"
    && Number.isFinite(page.width)
    && page.width > 0
    && typeof page.height === "number"
    && Number.isFinite(page.height)
    && page.height > 0
    && [0, 90, 180, 270].includes(Number(page.rotation));
}
