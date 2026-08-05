import { DurableObject } from "cloudflare:workers";
import { PLAN_LIMITS } from "./rate-card";
import type { Env, Plan } from "./types";

export class TenantGate extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active INTEGER NOT NULL,
        queued INTEGER NOT NULL,
        minute INTEGER NOT NULL,
        minute_count INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO state(singleton, active, queued, minute, minute_count)
      VALUES (1, 0, 0, 0, 0);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json<{ plan: Plan; background?: boolean }>() : undefined;
    if (url.pathname === "/acquire" && body) return this.acquire(body.plan, Boolean(body.background));
    if (url.pathname === "/release" && body) return this.release(Boolean(body.background));
    return Response.json(this.current());
  }

  private acquire(plan: Plan, background: boolean): Response {
    const limits = PLAN_LIMITS[plan];
    const state = this.current();
    const minute = Math.floor(Date.now() / 60_000);
    const minuteCount = state.minute === minute ? state.minuteCount : 0;
    if (minuteCount >= limits.perMinute) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
    if (background && state.queued >= limits.queued) return Response.json({ error: "QUEUE_FULL" }, { status: 429 });
    if (!background && state.active >= limits.active) return Response.json({ error: "CONCURRENCY_LIMIT" }, { status: 429 });
    this.ctx.storage.sql.exec(
      `UPDATE state SET active = ?, queued = ?, minute = ?, minute_count = ? WHERE singleton = 1`,
      state.active + (background ? 0 : 1),
      state.queued + (background ? 1 : 0),
      minute,
      minuteCount + 1,
    );
    return Response.json({ acquired: true, priority: limits.weight });
  }

  private release(background: boolean): Response {
    const state = this.current();
    this.ctx.storage.sql.exec(
      `UPDATE state SET active = ?, queued = ? WHERE singleton = 1`,
      Math.max(0, state.active - (background ? 0 : 1)),
      Math.max(0, state.queued - (background ? 1 : 0)),
    );
    return Response.json({ released: true });
  }

  private current(): { active: number; queued: number; minute: number; minuteCount: number } {
    const row = this.ctx.storage.sql
      .exec<{ active: number; queued: number; minute: number; minute_count: number }>(
        "SELECT active, queued, minute, minute_count FROM state WHERE singleton = 1",
      )
      .one();
    return { active: row.active, queued: row.queued, minute: row.minute, minuteCount: row.minute_count };
  }
}
