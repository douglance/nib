type JsonObject = Record<string, unknown>;

interface FileStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export interface NibFileBackendOptions {
  tenantId: string;
  storage: FileStorage;
  media: R2Bucket;
}

export interface NibFileRecord {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  derivedFromFileId?: string;
  requestId?: string;
  previewURL: string | null;
  contentURL: string;
  metadata: JsonObject;
}

interface StoredNibFileRecord extends NibFileRecord {
  tenantId: string;
  contentObjectKey: string;
  previewObjectKey: string | null;
  previewContentType: string | null;
}

interface UploadRecord {
  id: string;
  tenantId: string;
  fileId: string;
  idempotencyKey: string;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  derivedFromFileId: string | null;
  requestId: string | null;
  metadata: JsonObject;
  contentObjectKey: string;
  status: "initiated" | "content-uploaded" | "completed" | "aborted";
  createdAt: string;
  updatedAt: string;
}

interface IdempotencyReceipt {
  fingerprint: string;
  status: number;
  body: unknown;
}

interface InitiateInput {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  derivedFromFileId: string | null;
  requestId: string | null;
  metadata: JsonObject;
}

const MAX_FILE_BYTES = 96 * 1024 * 1024;
const FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class NibFileBackend {
  private readonly tenantId: string;
  private readonly storage: FileStorage;
  private readonly media: R2Bucket;

  constructor(options: NibFileBackendOptions) {
    this.tenantId = safeTenantId(options.tenantId);
    this.storage = options.storage;
    this.media = options.media;
  }

  async fetch(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === "/api/nib-files" && request.method === "GET") return this.listFiles();
    if (url.pathname === "/api/nib-files/uploads" && request.method === "POST") return this.initiateUpload(request);

    const uploadMatch = url.pathname.match(/^\/api\/nib-files\/uploads\/([^/]+)\/(content|complete|abort)$/);
    if (uploadMatch) {
      const uploadId = decodeURIComponent(uploadMatch[1]);
      const action = uploadMatch[2];
      if (action === "content" && request.method === "PUT") return this.putUploadContent(uploadId, request);
      if (action === "complete" && request.method === "POST") return this.completeUpload(uploadId, request);
      if (action === "abort" && request.method === "POST") return this.abortUpload(uploadId, request);
      return json({ error: "Method not allowed" }, 405);
    }

    const fileMatch = url.pathname.match(/^\/api\/nib-files\/([^/]+)(?:\/(content|preview))?$/);
    if (!fileMatch) return null;
    const fileId = decodeURIComponent(fileMatch[1]);
    const action = fileMatch[2];
    if (!action && request.method === "GET") return this.getFile(fileId);
    if (action === "content" && request.method === "GET") return this.fileContent(fileId, request);
    if (action === "preview" && request.method === "GET") return this.filePreview(fileId, request);
    return json({ error: "Method not allowed" }, 405);
  }

  private async listFiles(): Promise<Response> {
    const stored = await this.storage.list<StoredNibFileRecord>({ prefix: this.filePrefix() });
    const files = [...stored.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicFile);
    return json({ files });
  }

  private async getFile(fileId: string): Promise<Response> {
    const file = await this.fileRecord(fileId);
    return file ? json(publicFile(file)) : json({ error: "File not found" }, 404);
  }

  private async initiateUpload(request: Request): Promise<Response> {
    const input = await request.json<JsonObject>();
    const parsed = parseInitiateInput(input);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    const idempotencyKey = mutationIdempotencyKey(request, input);
    if (!idempotencyKey) return json({ error: "Idempotency-Key is required" }, 400);
    const fingerprint = stableStringify(parsed);
    return this.idempotent(`initiate:${parsed.id}`, idempotencyKey, fingerprint, async () => {
      const existing = await this.fileRecord(parsed.id);
      if (existing) return sameFile(existing, parsed)
        ? { status: 200, body: { upload: completedUpload(existing, idempotencyKey), file: publicFile(existing) } }
        : { status: 409, body: { error: "File ID already exists with a different hash" } };

      const existingUpload = await this.uploadByFileId(parsed.id);
      if (existingUpload && existingUpload.sha256 !== parsed.sha256) {
        return { status: 409, body: { error: "File ID already has an upload with a different hash" } };
      }
      if (existingUpload && uploadMatches(existingUpload, parsed)) {
        return { status: 201, body: { upload: uploadPayload(existingUpload) } };
      }

      const now = new Date().toISOString();
      const upload: UploadRecord = {
        ...parsed,
        id: crypto.randomUUID(),
        tenantId: this.tenantId,
        fileId: parsed.id,
        idempotencyKey,
        contentObjectKey: this.contentObjectKey(parsed.id),
        status: "initiated",
        createdAt: now,
        updatedAt: now
      };
      await this.storage.put(this.uploadKey(upload.id), upload);
      await this.storage.put(this.uploadFileKey(upload.fileId), upload.id);
      return { status: 201, body: { upload: uploadPayload(upload) } };
    });
  }

  private async putUploadContent(uploadId: string, request: Request): Promise<Response> {
    const idempotencyKey = mutationIdempotencyKey(request);
    if (!idempotencyKey) return json({ error: "Idempotency-Key is required" }, 400);
    const bytes = await request.arrayBuffer();
    const bodyHash = await sha256Hex(bytes);
    const fingerprint = stableStringify({ uploadId, bodyHash, contentType: request.headers.get("content-type") || "" });
    return this.idempotent(`content:${uploadId}`, idempotencyKey, fingerprint, async () => {
      const upload = await this.uploadRecord(uploadId);
      if (!upload || upload.status === "aborted") return { status: 404, body: { error: "Upload not found" } };
      if (upload.status === "completed") return { status: 409, body: { error: "Upload already completed" } };
      if (bytes.byteLength !== upload.bytes) return { status: 400, body: { error: "Uploaded content length does not match initiated file" } };
      if (bodyHash !== upload.sha256) return { status: 400, body: { error: "Uploaded content hash does not match initiated file" } };
      await this.media.put(upload.contentObjectKey, bytes, {
        httpMetadata: { contentType: upload.contentType },
        customMetadata: {
          tenantId: this.tenantId,
          fileId: upload.fileId,
          sha256: upload.sha256
        },
        sha256: hexToBytes(upload.sha256)
      });
      upload.status = "content-uploaded";
      upload.updatedAt = new Date().toISOString();
      await this.storage.put(this.uploadKey(upload.id), upload);
      return { status: 200, body: { upload: uploadPayload(upload) } };
    });
  }

  private async completeUpload(uploadId: string, request: Request): Promise<Response> {
    const input = await optionalJson(request);
    const idempotencyKey = mutationIdempotencyKey(request, input);
    if (!idempotencyKey) return json({ error: "Idempotency-Key is required" }, 400);
    const preview = await parsePreview(input);
    if ("error" in preview) return json({ error: preview.error }, 400);
    const fingerprint = stableStringify({ uploadId, preview: preview.value });
    return this.idempotent(`complete:${uploadId}`, idempotencyKey, fingerprint, async () => {
      const upload = await this.uploadRecord(uploadId);
      if (!upload || upload.status === "aborted") return { status: 404, body: { error: "Upload not found" } };
      const existing = await this.fileRecord(upload.fileId);
      if (existing) return sameFile(existing, upload)
        ? { status: 200, body: { file: existing } }
        : { status: 409, body: { error: "File ID already exists with a different hash" } };
      if (upload.status !== "content-uploaded") return { status: 409, body: { error: "Upload content is not complete" } };

      const object = await this.media.get(upload.contentObjectKey);
      if (!object) return { status: 409, body: { error: "Uploaded content is missing" } };
      if (object.size !== upload.bytes) return { status: 409, body: { error: "Uploaded content length changed" } };
      if (bytesToHex(object.checksums.sha256) !== upload.sha256) {
        return { status: 409, body: { error: "Uploaded content hash changed" } };
      }

      const now = new Date().toISOString();
      const previewRecord = await this.putPreview(upload, preview.value);
      const file: StoredNibFileRecord = {
        id: upload.fileId,
        tenantId: upload.tenantId,
        name: upload.name,
        contentType: upload.contentType,
        bytes: upload.bytes,
        sha256: upload.sha256,
        ...(upload.derivedFromFileId ? { derivedFromFileId: upload.derivedFromFileId } : {}),
        ...(upload.requestId ? { requestId: upload.requestId } : {}),
        metadata: upload.metadata,
        contentURL: `/api/nib-files/${encodeURIComponent(upload.fileId)}/content`,
        previewURL: previewRecord ? `/api/nib-files/${encodeURIComponent(upload.fileId)}/preview` : null,
        createdAt: now,
        contentObjectKey: upload.contentObjectKey,
        previewObjectKey: previewRecord?.objectKey || null,
        previewContentType: previewRecord?.contentType || null
      };
      upload.status = "completed";
      upload.updatedAt = now;
      await Promise.all([
        this.storage.put(this.fileKey(file.id), file),
        this.storage.put(this.uploadKey(upload.id), upload)
      ]);
      return { status: 201, body: { file: publicFile(file) } };
    });
  }

  private async abortUpload(uploadId: string, request: Request): Promise<Response> {
    const idempotencyKey = mutationIdempotencyKey(request);
    if (!idempotencyKey) return json({ error: "Idempotency-Key is required" }, 400);
    const fingerprint = stableStringify({ uploadId });
    return this.idempotent(`abort:${uploadId}`, idempotencyKey, fingerprint, async () => {
      const upload = await this.uploadRecord(uploadId);
      if (!upload) return { status: 404, body: { error: "Upload not found" } };
      if (upload.status === "completed") return { status: 409, body: { error: "Completed files are immutable" } };
      upload.status = "aborted";
      upload.updatedAt = new Date().toISOString();
      await Promise.all([
        this.media.delete(upload.contentObjectKey),
        this.storage.put(this.uploadKey(upload.id), upload),
        this.storage.delete(this.uploadFileKey(upload.fileId))
      ]);
      return { status: 200, body: { upload: uploadPayload(upload) } };
    });
  }

  private async fileContent(fileId: string, request: Request): Promise<Response> {
    const file = await this.fileRecord(fileId);
    if (!file) return json({ error: "File not found" }, 404);
    return this.objectResponse(file.contentObjectKey, file.contentType, file.bytes, request);
  }

  private async filePreview(fileId: string, request: Request): Promise<Response> {
    const file = await this.fileRecord(fileId);
    if (!file || !file.previewObjectKey || !file.previewContentType) return json({ error: "Preview not found" }, 404);
    return this.objectResponse(file.previewObjectKey, file.previewContentType, undefined, request);
  }

  private async objectResponse(key: string, contentType: string, fullSize: number | undefined, request: Request): Promise<Response> {
    const range = parseRange(request.headers.get("range"), fullSize);
    if (range && "error" in range) return json({ error: range.error }, 416, { "accept-ranges": "bytes" });
    const object = await this.media.get(key, range ? { range: range.r2Range } : undefined);
    if (!object) return json({ error: "File not found" }, 404);
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=300",
      "content-type": contentType
    });
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    if (range && fullSize !== undefined) {
      headers.set("content-range", `bytes ${range.start}-${range.end}/${fullSize}`);
      headers.set("content-length", String(range.end - range.start + 1));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  }

  private async putPreview(upload: UploadRecord, preview: PreviewInput | null): Promise<{ objectKey: string; contentType: string } | null> {
    if (!preview) {
      if (!upload.contentType.startsWith("image/")) return null;
      return { objectKey: upload.contentObjectKey, contentType: upload.contentType };
    }
    const objectKey = this.previewObjectKey(upload.fileId);
    await this.media.put(objectKey, preview.bytes, {
      httpMetadata: { contentType: preview.contentType },
      customMetadata: {
        tenantId: this.tenantId,
        fileId: upload.fileId,
        role: "preview"
      }
    });
    return { objectKey, contentType: preview.contentType };
  }

  private async idempotent(
    operation: string,
    idempotencyKey: string,
    fingerprint: string,
    run: () => Promise<{ status: number; body: unknown }>
  ): Promise<Response> {
    const key = this.receiptKey(operation, idempotencyKey);
    const existing = await this.storage.get<IdempotencyReceipt>(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return json({ error: "Idempotency key was reused with a different request" }, 409);
      return json(existing.body, existing.status);
    }
    const result = await run();
    if (result.status < 500) await this.storage.put(key, { fingerprint, ...result });
    return json(result.body, result.status);
  }

  private async uploadByFileId(fileId: string): Promise<UploadRecord | undefined> {
    const uploadId = await this.storage.get<string>(this.uploadFileKey(fileId));
    return uploadId ? this.uploadRecord(uploadId) : undefined;
  }

  private fileRecord(fileId: string): Promise<StoredNibFileRecord | undefined> {
    if (!FILE_ID_PATTERN.test(fileId)) return Promise.resolve(undefined);
    return this.storage.get<StoredNibFileRecord>(this.fileKey(fileId));
  }

  private uploadRecord(uploadId: string): Promise<UploadRecord | undefined> {
    if (!FILE_ID_PATTERN.test(uploadId)) return Promise.resolve(undefined);
    return this.storage.get<UploadRecord>(this.uploadKey(uploadId));
  }

  private filePrefix(): string {
    return `nib-file:${this.tenantId}:`;
  }

  private fileKey(fileId: string): string {
    return `${this.filePrefix()}${fileId}`;
  }

  private uploadKey(uploadId: string): string {
    return `nib-upload:${this.tenantId}:${uploadId}`;
  }

  private uploadFileKey(fileId: string): string {
    return `nib-upload-file:${this.tenantId}:${fileId}`;
  }

  private receiptKey(operation: string, idempotencyKey: string): string {
    return `nib-idempotency:${this.tenantId}:${operation}:${idempotencyKey}`;
  }

  private contentObjectKey(fileId: string): string {
    return `tenants/${this.tenantId}/nib-files/${fileId}/content`;
  }

  private previewObjectKey(fileId: string): string {
    return `tenants/${this.tenantId}/nib-files/${fileId}/preview`;
  }
}

interface PreviewInput {
  contentType: string;
  bytes: ArrayBuffer;
}

function parseInitiateInput(input: JsonObject): InitiateInput | { error: string } {
  const id = text(input.id);
  const bytes = Number(input.bytes);
  const sha256 = text(input.sha256).toLowerCase();
  if (!FILE_ID_PATTERN.test(id)) return { error: "File id must be 1-128 URL-safe characters" };
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_FILE_BYTES) return { error: "File bytes must be between 0 and 96 MiB" };
  if (!HEX_SHA256_PATTERN.test(sha256)) return { error: "File sha256 must be a lowercase hex SHA-256 digest" };
  return {
    id,
    name: safeName(text(input.name) || id),
    contentType: text(input.contentType) || "application/octet-stream",
    bytes,
    sha256,
    derivedFromFileId: nullableId(input.derivedFromFileId),
    requestId: nullableId(input.requestId),
    metadata: object(input.metadata)
  };
}

async function parsePreview(input: JsonObject): Promise<{ value: PreviewInput | null } | { error: string }> {
  const encoded = text(input.previewContentBase64);
  if (!encoded) return { value: null };
  const bytes = decodeBase64(encoded);
  const contentType = text(input.previewContentType);
  if (!contentType.startsWith("image/")) return { error: "Preview content type must be an image" };
  const expected = text(input.previewSha256).toLowerCase();
  if (expected && (!HEX_SHA256_PATTERN.test(expected) || expected !== await sha256Hex(bytes))) {
    return { error: "Preview sha256 does not match preview content" };
  }
  return { value: { contentType, bytes } };
}

function parseRange(value: string | null, fullSize: number | undefined): { r2Range: R2Range; start: number; end: number } | { error: string } | null {
  if (!value) return null;
  if (fullSize === undefined) return { error: "Range not satisfiable" };
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { error: "Unsupported range" };
  const left = match[1];
  const right = match[2];
  if (!left && !right) return { error: "Unsupported range" };
  if (!left) {
    const suffix = Number(right);
    if (!Number.isInteger(suffix) || suffix <= 0) return { error: "Unsupported range" };
    const start = Math.max(0, fullSize - suffix);
    return { r2Range: { suffix }, start, end: fullSize - 1 };
  }
  const start = Number(left);
  const end = right ? Number(right) : fullSize - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= fullSize) {
    return { error: "Range not satisfiable" };
  }
  const boundedEnd = Math.min(end, fullSize - 1);
  return { r2Range: { offset: start, length: boundedEnd - start + 1 }, start, end: boundedEnd };
}

function uploadPayload(upload: UploadRecord): JsonObject {
  return {
    id: upload.id,
    fileId: upload.fileId,
    status: upload.status,
    contentURL: `/api/nib-files/uploads/${encodeURIComponent(upload.id)}/content`,
    completeURL: `/api/nib-files/uploads/${encodeURIComponent(upload.id)}/complete`,
    abortURL: `/api/nib-files/uploads/${encodeURIComponent(upload.id)}/abort`,
    createdAt: upload.createdAt
  };
}

function completedUpload(file: StoredNibFileRecord, idempotencyKey: string): JsonObject {
  return {
    id: file.id,
    fileId: file.id,
    status: "completed",
    idempotencyKey,
    contentURL: file.contentURL,
    completeURL: null,
    abortURL: null,
    createdAt: file.createdAt
  };
}

function publicFile(file: StoredNibFileRecord): NibFileRecord {
  return {
    id: file.id,
    name: file.name,
    contentType: file.contentType,
    bytes: file.bytes,
    sha256: file.sha256,
    createdAt: file.createdAt,
    ...(file.derivedFromFileId ? { derivedFromFileId: file.derivedFromFileId } : {}),
    ...(file.requestId ? { requestId: file.requestId } : {}),
    previewURL: file.previewURL,
    contentURL: file.contentURL,
    metadata: file.metadata
  };
}

function sameFile(existing: StoredNibFileRecord, input: Pick<InitiateInput, "sha256" | "bytes" | "contentType">): boolean {
  return existing.sha256 === input.sha256
    && existing.bytes === input.bytes
    && existing.contentType === input.contentType;
}

function uploadMatches(upload: UploadRecord, input: InitiateInput): boolean {
  return upload.fileId === input.id
    && upload.sha256 === input.sha256
    && upload.bytes === input.bytes
    && upload.contentType === input.contentType
    && upload.name === input.name
    && upload.derivedFromFileId === input.derivedFromFileId
    && upload.requestId === input.requestId
    && stableStringify(upload.metadata) === stableStringify(input.metadata);
}

function mutationIdempotencyKey(request: Request, input: JsonObject = {}): string {
  return text(request.headers.get("idempotency-key")) || text(input.idempotencyKey);
}

async function optionalJson(request: Request): Promise<JsonObject> {
  if (!(request.headers.get("content-type") || "").includes("application/json")) return {};
  return object(await request.json());
}

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...extra } });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function nullableId(value: unknown): string | null {
  const id = text(value);
  return id && FILE_ID_PATTERN.test(id) ? id : null;
}

function safeTenantId(value: string): string {
  return (value || "primary").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "primary";
}

function safeName(value: string): string {
  return value.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "file";
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return bytesToHex(digest);
}

function bytesToHex(value: ArrayBuffer | undefined): string {
  if (!value) return "";
  return bytesToHexSync(value);
}

function bytesToHexSync(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!value || typeof value !== "object") return value;
  const sorted: JsonObject = {};
  for (const key of Object.keys(value as JsonObject).sort()) sorted[key] = sortStable((value as JsonObject)[key]);
  return sorted;
}
