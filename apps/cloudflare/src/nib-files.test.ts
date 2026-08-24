import { describe, expect, it } from "vitest";
import { NibFileBackend } from "./nib-files";

class FakeStorage {
  values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const [key, value] of this.values) {
      if (key.startsWith(options.prefix)) result.set(key, value as T);
    }
    return result;
  }
}

class FakeR2Object {
  key: string;
  data: Uint8Array;
  size: number;
  httpEtag: string;
  etag: string;
  checksums: R2Checksums;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  version = "fake";
  uploaded = new Date();
  storageClass = "Standard";
  range?: R2Range;

  constructor(key: string, bytes: Uint8Array, options?: R2PutOptions, range?: R2Range) {
    this.key = key;
    this.data = bytes;
    this.size = bytes.byteLength;
    this.etag = `"${key}"`;
    this.httpEtag = this.etag;
    this.httpMetadata = options?.httpMetadata as R2HTTPMetadata | undefined;
    this.customMetadata = options?.customMetadata;
    this.checksums = {
      sha256: options?.sha256 instanceof Uint8Array ? arrayBufferFrom(options.sha256) : options?.sha256 as ArrayBuffer | undefined,
      toJSON() {
        return {};
      }
    } as R2Checksums;
    this.range = range;
  }

  get body(): ReadableStream {
    return new Response(arrayBufferFrom(this.data)).body as ReadableStream;
  }

  get bodyUsed(): boolean {
    return false;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(arrayBufferFrom(this.data));
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(this.data);
  }

  text(): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(this.data));
  }

  json<T>(): Promise<T> {
    return this.text().then((text) => JSON.parse(text) as T);
  }

  blob(): Promise<Blob> {
    return Promise.resolve(new Blob([arrayBufferFrom(this.data)], { type: this.httpMetadata?.contentType }));
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata?.contentType) headers.set("content-type", this.httpMetadata.contentType);
  }
}

class FakeR2Bucket {
  values = new Map<string, FakeR2Object>();

  async head(key: string): Promise<R2Object | null> {
    return this.values.get(key) as unknown as R2Object | null;
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    const object = this.values.get(key);
    if (!object) return null;
    const range = options?.range && !(options.range instanceof Headers) ? options.range : null;
    if (!range) return object as unknown as R2ObjectBody;
    const { start, end } = resolveRange(range, object.size);
    return new FakeR2Object(key, object.data.slice(start, end + 1), {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      sha256: object.checksums.sha256
    }, range) as unknown as R2ObjectBody;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions
  ): Promise<R2Object> {
    const bytes = await valueBytes(value);
    this.values.set(key, new FakeR2Object(key, bytes, options));
    return this.values.get(key) as unknown as R2Object;
  }

  createMultipartUpload(): R2MultipartUpload {
    throw new Error("not implemented");
  }

  resumeMultipartUpload(): R2MultipartUpload {
    throw new Error("not implemented");
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async list(): Promise<R2Objects> {
    throw new Error("not implemented");
  }
}

describe("NibFileBackend", () => {
  it("completes immutable client-generated files and returns exact retries", async () => {
    const backend = testBackend();
    const content = new TextEncoder().encode("canonical nib file");
    const sha256 = await digestHex(content);

    const initiated = await postJson(backend, "/api/nib-files/uploads", {
      id: "file-1",
      name: "review.nib",
      contentType: "application/x-nib",
      bytes: content.byteLength,
      sha256,
      derivedFromFileId: "source-1",
      requestId: "request-1",
      metadata: { role: "canonical" }
    }, "init-file-1");
    expect(initiated.status).toBe(201);
    const initiatedBody = await initiated.json() as { upload: { id: string; contentURL: string; completeURL: string } };

    const uploaded = await fetchBackend(backend, initiatedBody.upload.contentURL, {
      method: "PUT",
      headers: { "idempotency-key": "content-file-1", "content-type": "application/x-nib" },
      body: arrayBufferFrom(content)
    });
    expect(uploaded.status).toBe(200);

    const completed = await postJson(backend, initiatedBody.upload.completeURL, {}, "complete-file-1");
    expect(completed.status).toBe(201);
    const completedBody = await completed.json() as { file: Record<string, unknown> };
    expect(completedBody.file).toMatchObject({
      id: "file-1",
      name: "review.nib",
      contentType: "application/x-nib",
      bytes: content.byteLength,
      sha256,
      derivedFromFileId: "source-1",
      requestId: "request-1",
      previewURL: null,
      contentURL: "/api/nib-files/file-1/content",
      metadata: { role: "canonical" }
    });
    expect(completedBody.file).not.toHaveProperty("updatedAt");
    expect(completedBody.file).not.toHaveProperty("version");

    const retry = await postJson(backend, "/api/nib-files/uploads", {
      id: "file-1",
      name: "review.nib",
      contentType: "application/x-nib",
      bytes: content.byteLength,
      sha256,
      derivedFromFileId: "source-1",
      requestId: "request-1",
      metadata: { role: "canonical" }
    }, "init-file-1");
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(initiatedBody);

    const laterSameFile = await postJson(backend, "/api/nib-files/uploads", {
      id: "file-1",
      name: "review.nib",
      contentType: "application/x-nib",
      bytes: content.byteLength,
      sha256
    }, "init-file-1-later");
    expect(laterSameFile.status).toBe(200);
    expect(await laterSameFile.json()).toMatchObject({ file: completedBody.file });
  });

  it("rejects the same file id with different hash or bytes", async () => {
    const backend = testBackend();
    const content = new TextEncoder().encode("one");
    const sha256 = await digestHex(content);
    const upload = await createCompleteFile(backend, "same-id", content, sha256);
    expect(upload.status).toBe(201);

    const different = await postJson(backend, "/api/nib-files/uploads", {
      id: "same-id",
      name: "other.nib",
      contentType: "application/x-nib",
      bytes: 5,
      sha256: await digestHex(new TextEncoder().encode("other"))
    }, "init-conflict");
    expect(different.status).toBe(409);
    expect(await different.json()).toEqual({ error: "File ID already exists with a different hash" });
  });

  it("serves content, previews, byte ranges, and tenant-scoped lists", async () => {
    const storage = new FakeStorage();
    const media = new FakeR2Bucket();
    const tenantA = new NibFileBackend({ tenantId: "tenant-a", storage, media: media as unknown as R2Bucket });
    const tenantB = new NibFileBackend({ tenantId: "tenant-b", storage, media: media as unknown as R2Bucket });
    const content = new TextEncoder().encode("abcdefghij");
    const preview = new TextEncoder().encode("png-preview");
    const completed = await createCompleteFile(tenantA, "shared-id", content, await digestHex(content), {
      previewContentType: "image/png",
      previewContentBase64: btoa(String.fromCharCode(...preview)),
      previewSha256: await digestHex(preview)
    });
    expect(completed.status).toBe(201);

    const listA = await fetchBackend(tenantA, "/api/nib-files");
    expect(await listA.json()).toMatchObject({ files: [{ id: "shared-id", previewURL: "/api/nib-files/shared-id/preview" }] });
    const listB = await fetchBackend(tenantB, "/api/nib-files");
    expect(await listB.json()).toEqual({ files: [] });

    const range = await fetchBackend(tenantA, "/api/nib-files/shared-id/content", { headers: { range: "bytes=2-5" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await range.text()).toBe("cdef");

    const previewResponse = await fetchBackend(tenantA, "/api/nib-files/shared-id/preview");
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("content-type")).toBe("image/png");
    expect(await previewResponse.text()).toBe("png-preview");
  });
});

function testBackend(): NibFileBackend {
  return new NibFileBackend({
    tenantId: "primary",
    storage: new FakeStorage(),
    media: new FakeR2Bucket() as unknown as R2Bucket
  });
}

async function createCompleteFile(
  backend: NibFileBackend,
  id: string,
  content: Uint8Array,
  sha256: string,
  completeInput: Record<string, unknown> = {}
): Promise<Response> {
  const initiated = await postJson(backend, "/api/nib-files/uploads", {
    id,
    name: `${id}.nib`,
    contentType: "application/x-nib",
    bytes: content.byteLength,
    sha256
  }, `init-${id}`);
  const body = await initiated.json() as { upload: { contentURL: string; completeURL: string } };
  await fetchBackend(backend, body.upload.contentURL, {
    method: "PUT",
    headers: { "idempotency-key": `content-${id}`, "content-type": "application/x-nib" },
    body: arrayBufferFrom(content)
  });
  return postJson(backend, body.upload.completeURL, completeInput, `complete-${id}`);
}

function postJson(backend: NibFileBackend, path: string, body: unknown, key: string): Promise<Response> {
  return fetchBackend(backend, path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body)
  });
}

async function fetchBackend(backend: NibFileBackend, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await backend.fetch(new Request(`https://nib.example.com${path}`, init));
  if (!response) throw new Error(`No route handled ${path}`);
  return response;
}

async function digestHex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBufferFrom(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBufferFrom(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function valueBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value === null) return new Uint8Array();
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function resolveRange(range: R2Range, size: number): { start: number; end: number } {
  if ("suffix" in range) return { start: Math.max(0, size - range.suffix), end: size - 1 };
  const start = range.offset || 0;
  const end = range.length ? start + range.length - 1 : size - 1;
  return { start, end: Math.min(end, size - 1) };
}
