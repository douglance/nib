import { DurableObject } from "cloudflare:workers";
import { trialClaimError } from "./trial-policy";
import type { Env } from "./types";

export class TrialGate extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        tenant_id TEXT PRIMARY KEY,
        network_hash TEXT NOT NULL,
        claimed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS claims_network_time ON claims(network_hash, claimed_at);
      CREATE INDEX IF NOT EXISTS claims_time ON claims(claimed_at);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/claim") return new Response("Not found", { status: 404 });
    const body = await request.json<{ tenantId?: string; networkHash?: string }>();
    const tenantId = body.tenantId?.trim().toLowerCase();
    const networkHash = body.networkHash?.trim().toLowerCase();
    if (!tenantId || !networkHash || !/^[0-9a-f]{64}$/.test(networkHash)) {
      return Response.json({ error: "INVALID_TRIAL_CLAIM" }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);
    const networkCutoff = now - 30 * 86_400;
    const dayStart = now - (now % 86_400);
    const existingIdentity = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM claims WHERE tenant_id = ?", tenantId)
      .one().count > 0;
    const networkClaims = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM claims WHERE network_hash = ? AND claimed_at >= ?",
        networkHash,
        networkCutoff,
      )
      .one().count;
    const dailyClaims = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM claims WHERE claimed_at >= ?", dayStart)
      .one().count;
    const limits = {
      networkMax: positiveInteger(this.env.TRIAL_NETWORK_IDENTITIES_30D, 3),
      dailyMax: positiveInteger(this.env.TRIAL_GLOBAL_DAILY_LIMIT, 50),
    };
    const error = trialClaimError({ existingIdentity, networkClaims, dailyClaims }, limits);
    if (error) return Response.json({ error }, { status: 429 });
    if (!existingIdentity) {
      this.ctx.storage.sql.exec(
        "INSERT INTO claims(tenant_id, network_hash, claimed_at) VALUES (?, ?, ?)",
        tenantId,
        networkHash,
        now,
      );
    }
    return Response.json({ claimed: true, existing: existingIdentity });
  }
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
