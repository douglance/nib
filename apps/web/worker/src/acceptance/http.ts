export class AcceptanceHttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function acceptanceJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  } });
}

export function acceptanceErrorResponse(error: unknown): Response {
  let value = error as { status?: number; code?: string; message?: string } | null;
  if (typeof value?.message === "string") {
    const marker = "NIB_ACCEPTANCE_ERROR:";
    const offset = value.message.indexOf(marker);
    if (offset >= 0) {
      try { value = JSON.parse(value.message.slice(offset + marker.length)); } catch { /* Unrecognized RPC failures stay internal. */ }
    }
  }
  const status = typeof value?.status === "number" && value.status >= 400 && value.status <= 599 ? value.status : 500;
  return acceptanceJson({ error: {
    code: status === 500 ? "internal_error" : value?.code || "request_failed",
    message: status === 500 ? "Nib could not complete this operation. Retry with the same idempotency key." : value?.message || "Request failed",
  } }, status);
}

export function mutationKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new AcceptanceHttpError(400, "idempotency_key_required", "Provide an Idempotency-Key of 1 to 200 characters.");
  }
  return key;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new AcceptanceHttpError(403, "origin_not_allowed", "This request must come from the Nib review page.");
  }
}

export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new AcceptanceHttpError(413, "body_too_large", `The request exceeds the ${limit}-byte limit.`);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AcceptanceHttpError(413, "body_too_large", `The request exceeds the ${limit}-byte limit.`);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AcceptanceHttpError(415, "json_required", "Send application/json.");
  }
  try {
    const bytes = await readBoundedBody(request, 1024 * 1024);
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("object required");
    return result as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AcceptanceHttpError) throw error;
    throw new AcceptanceHttpError(400, "invalid_json", "Send a valid JSON object.");
  }
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
