// @ts-ignore Node-only runtime integration harness.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

declare const process: { env: Record<string, string | undefined>; execPath: string };

describe("acceptance runtime integration", () => {
  it("runs the acceptance API, teams, Durable Object, D1, R2, receipts, revocation, and races in Miniflare", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/acceptance-runtime-harness.mjs", "run"],
      {
        cwd: new URL("../../..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
    );

    const result = JSON.parse(output) as {
      ok: boolean;
      runtime: string;
      concurrency: { voteCount: number; voteStates: string[] };
      revocation: { votes: number; verify: string };
      race: { oldState: string };
      persistence: { before: { outboxCount: number }; afterEvict: { outboxCount: number } };
      receipt: { approvals: number; manifestHash: string };
      d1: Record<string, number>;
      r2: { evidenceStatus: number };
    };
    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("miniflare-workerd");
    expect(result.concurrency.voteCount).toBe(2);
    expect(result.concurrency.voteStates).toContain("approved");
    expect(result.revocation).toEqual({ state: "pending", votes: 0, verify: "not_approved" });
    expect(result.race.oldState).toBe("superseded");
    expect(result.persistence.before.outboxCount).toBeGreaterThan(0);
    expect(result.persistence.afterEvict.outboxCount).toBeGreaterThanOrEqual(result.persistence.before.outboxCount);
    expect(result.receipt.approvals).toBe(2);
    expect(result.receipt.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.d1.acceptance_projects).toBe(1);
    expect(result.r2.evidenceStatus).toBe(200);
  }, 130_000);
});
