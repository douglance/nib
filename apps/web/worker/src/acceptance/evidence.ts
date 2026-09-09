import type { Env } from "../types";
import type { AcceptanceManifest } from "./contracts";
import { AcceptanceHttpError, acceptanceJson, mutationKey, readBoundedBody, sha256Bytes } from "./http";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "video/mp4", "application/pdf", "text/plain", "application/json"]);
// Hashing buffers the body and may copy it; leave room within the Worker heap.
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
interface EvidenceRow { digest: string; content_type: string; name: string; byte_length: number; ready: number }

export async function uploadEvidence(request: Request, env: Env, projectId: string, actorId: string): Promise<Response> {
  const key = mutationKey(request);
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
  if (!ALLOWED.has(contentType)) throw new AcceptanceHttpError(415, "unsupported_evidence", "Upload PNG, JPEG, WebP, MP4, PDF, plain text, or JSON evidence.");
  const name = (request.headers.get("x-nib-filename") || "evidence").split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "evidence";
  const bytes = await readBoundedBody(request, MAX_EVIDENCE_BYTES);
  if (!bytes.byteLength) throw new AcceptanceHttpError(400, "empty_evidence", "Evidence cannot be empty.");
  const digest = await sha256Bytes(bytes);
  const payloadHash = await sha256Bytes(new TextEncoder().encode(JSON.stringify([digest, contentType, name])));
  await env.DB.prepare("INSERT OR IGNORE INTO acceptance_upload_operations(project_id,actor_id,idempotency_key,payload_hash) VALUES (?,?,?,?)")
    .bind(projectId, actorId, key, payloadHash).run();
  const operation = await env.DB.prepare("SELECT payload_hash FROM acceptance_upload_operations WHERE project_id = ? AND actor_id = ? AND idempotency_key = ?")
    .bind(projectId, actorId, key).first<{ payload_hash: string }>();
  if (operation?.payload_hash !== payloadHash) throw new AcceptanceHttpError(409, "idempotency_conflict", "This idempotency key was used for different evidence.");
  await env.DB.prepare("INSERT OR IGNORE INTO acceptance_evidence(project_id,digest,content_type,name,byte_length) VALUES (?,?,?,?,?)")
    .bind(projectId, digest, contentType, name, bytes.byteLength).run();
  const row = await evidenceRow(env, projectId, digest);
  if (!row) throw new Error("evidence insert not visible");
  if (!row.ready) {
    // Content-addressed bytes are safe to resume after an interrupted metadata write.
    await env.ARTIFACTS.put(objectKey(projectId, digest), bytes, {
      httpMetadata: { contentType: row.content_type }, customMetadata: { projectId, sha256: digest },
    });
    await env.DB.prepare("UPDATE acceptance_evidence SET ready = 1 WHERE project_id = ? AND digest = ?").bind(projectId, digest).run();
  }
  return acceptanceJson(descriptor(row, projectId, env.PUBLIC_ORIGIN), 201);
}

export async function evidenceResponse(env: Env, projectId: string, digest: string): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new AcceptanceHttpError(404, "evidence_not_found", "Evidence not found.");
  const row = await evidenceRow(env, projectId, digest);
  if (!row?.ready) throw new AcceptanceHttpError(404, "evidence_not_found", "Evidence not found.");
  const object = await env.ARTIFACTS.get(objectKey(projectId, digest));
  if (!object) throw new AcceptanceHttpError(410, "evidence_unavailable", "This evidence is no longer available.");
  return new Response(object.body, { headers: {
    "content-type": row.content_type,
    "content-length": String(row.byte_length),
    "content-disposition": `${row.content_type.startsWith("image/") || row.content_type === "video/mp4" ? "inline" : "attachment"}; filename="${row.name}"`,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox", "referrer-policy": "no-referrer",
    "etag": `"${digest}"`,
  } });
}

export async function validateStoredEvidence(manifest: AcceptanceManifest, env: Env, projectId: string): Promise<void> {
  if (!Array.isArray(manifest.evidence)) return; // Schema validation reports malformed manifests.
  const origin = new URL(env.PUBLIC_ORIGIN).origin;
  for (const evidence of manifest.evidence) {
    if (!evidence || typeof evidence.url !== "string") continue;
    let url: URL;
    try { url = new URL(evidence.url); } catch { continue; }
    if (url.origin !== origin) continue;
    const match = url.pathname.match(/^\/api\/acceptance\/v1\/projects\/([^/]+)\/evidence\/([a-f0-9]{64})$/);
    if (!match || match[1] !== projectId || match[2] !== evidence.sha256 || url.search || url.hash) {
      throw new AcceptanceHttpError(400, "evidence_binding_mismatch", "Nib evidence must belong to this project and match its SHA-256.");
    }
    const row = await evidenceRow(env, projectId, match[2]!);
    if (!row?.ready || !(await env.ARTIFACTS.head(objectKey(projectId, match[2]!)))) {
      throw new AcceptanceHttpError(400, "evidence_missing", "Upload this packet's evidence before publishing.");
    }
    if (evidence.contentType && evidence.contentType !== row.content_type) {
      throw new AcceptanceHttpError(400, "evidence_type_mismatch", "Evidence content type does not match the stored artifact.");
    }
  }
}

function evidenceRow(env: Env, projectId: string, digest: string): Promise<EvidenceRow | null> {
  return env.DB.prepare("SELECT digest,content_type,name,byte_length,ready FROM acceptance_evidence WHERE project_id = ? AND digest = ?")
    .bind(projectId, digest).first<EvidenceRow>();
}
function objectKey(projectId: string, digest: string): string { return `acceptance/${projectId}/evidence/${digest}`; }
function descriptor(row: EvidenceRow, projectId: string, origin: string) {
  return {
    id: row.digest, kind: row.content_type.startsWith("image/") ? "image" : row.content_type === "video/mp4" ? "video" : "document",
    label: row.name, url: new URL(`/api/acceptance/v1/projects/${projectId}/evidence/${row.digest}`, origin).toString(),
    sha256: row.digest, contentType: row.content_type,
  };
}
