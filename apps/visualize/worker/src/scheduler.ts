import { DurableObject } from "cloudflare:workers";
import type { Env, Plan, StoredGenerationRequest } from "./types";

export class GenerationScheduler extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS generation_queue (
        job_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduler_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        slot INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO scheduler_state(singleton, slot) VALUES (1, 0);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const payload = await request.json<StoredGenerationRequest>();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO generation_queue(job_id, plan, payload, created_at) VALUES (?, ?, ?, ?)",
      payload.jobId,
      payload.plan,
      JSON.stringify(payload),
      Date.now(),
    );
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return Response.json({ queued: true });
  }

  async alarm(): Promise<void> {
    const slot = this.ctx.storage.sql.exec<{ slot: number }>("SELECT slot FROM scheduler_state WHERE singleton = 1").one().slot;
    const preferred: Plan = slot < 4 ? "high" : "default";
    const fallback: Plan = preferred === "high" ? "default" : "high";
    const row = this.next(preferred) ?? this.next(fallback);
    if (!row) return;
    const payload = JSON.parse(row.payload) as StoredGenerationRequest;
    await this.env.GENERATE_WORKFLOW.create({ id: payload.jobId, params: payload });
    this.ctx.storage.sql.exec("DELETE FROM generation_queue WHERE job_id = ?", payload.jobId);
    this.ctx.storage.sql.exec("UPDATE scheduler_state SET slot = ? WHERE singleton = 1", (slot + 1) % 5);
    const remaining = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM generation_queue").one().count;
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + 1);
  }

  private next(plan: Plan): { payload: string } | undefined {
    return this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM generation_queue WHERE plan = ? ORDER BY created_at, job_id LIMIT 1",
        plan,
      )
      .toArray()[0];
  }
}
