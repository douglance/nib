import type { AcceptanceManifest } from "./contracts";
import type { AutomationActor } from "./teams";
import { AcceptanceHttpError } from "./http";

const FRESHNESS_SECONDS = 60;
interface VerificationTarget {
  projectId: string;
  id: string;
  manifestHash: string;
  manifest: AcceptanceManifest;
}

// Customer credentials stay in CI. Authorized automation reports a just-completed
// provider probe; the server limits how long that report may satisfy a gate.
export async function recordProviderVerification(
  db: D1Database, review: VerificationTarget, actor: AutomationActor | null,
  value: unknown, key: string, now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!actor || actor.projectId !== review.projectId || !actor.scopes.includes("verify")) {
    throw new AcceptanceHttpError(403, "provider_verification_forbidden", "Only project automation with verify scope can report a provider version check.");
  }
  const input = value as Record<string, unknown> | null;
  const verifiedAt = typeof input?.verifiedAt === "string" ? Math.floor(Date.parse(input.verifiedAt) / 1000) : NaN;
  if (review.manifest.build.provider !== "cloudflare" || input?.manifestHash !== review.manifestHash ||
      input?.commit !== review.manifest.build.commit || !Number.isFinite(verifiedAt) ||
      verifiedAt > now + 5 || verifiedAt <= now - FRESHNESS_SECONDS) {
    throw new AcceptanceHttpError(400, "provider_verification_invalid", "Report a Cloudflare version check from the past 60 seconds for this exact manifest and commit.");
  }
  await db.prepare(`INSERT OR IGNORE INTO acceptance_provider_verifications
    (project_id,review_id,actor_id,idempotency_key,manifest_hash,commit_sha,verified_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(review.projectId, review.id, actor.id, key,
      review.manifestHash, review.manifest.build.commit, verifiedAt, verifiedAt + FRESHNESS_SECONDS).run();
  const stored = await db.prepare(`SELECT review_id,manifest_hash,commit_sha,verified_at
    FROM acceptance_provider_verifications WHERE project_id = ? AND actor_id = ? AND idempotency_key = ?`)
    .bind(review.projectId, actor.id, key).first<{ review_id: string; manifest_hash: string; commit_sha: string; verified_at: number }>();
  if (!stored || stored.review_id !== review.id || stored.manifest_hash !== review.manifestHash ||
      stored.commit_sha !== review.manifest.build.commit || stored.verified_at !== verifiedAt) {
    throw new AcceptanceHttpError(409, "idempotency_conflict", "This key was used for a different provider version check.");
  }
}

export async function hasFreshProviderVerification(
  db: D1Database, review: VerificationTarget, now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (review.manifest.build.provider !== "cloudflare") return true;
  const row = await db.prepare(`SELECT 1 AS fresh FROM acceptance_provider_verifications
    WHERE project_id = ? AND review_id = ? AND manifest_hash = ? AND commit_sha = ?
      AND verified_at <= ? AND expires_at > ? LIMIT 1`)
    .bind(review.projectId, review.id, review.manifestHash, review.manifest.build.commit, now + 5, now).first();
  return !!row;
}
