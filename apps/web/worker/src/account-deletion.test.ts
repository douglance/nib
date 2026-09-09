import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteAccount, deleteR2Prefix, purgeDeletedAccountArtifacts } from "./account-deletion";
import type { Env } from "./types";

class FakeR2Bucket {
  values = new Set<string>();

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const objects = [...this.values]
      .filter((key) => key.startsWith(prefix))
      .slice(0, options?.limit ?? 1_000)
      .map((key) => ({ key }));
    return { objects, truncated: false } as R2Objects;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}

describe("account artifact deletion", () => {
  it("deletes every matching page while preserving other accounts", async () => {
    const bucket = new FakeR2Bucket();
    for (let index = 0; index < 1_205; index++) {
      bucket.values.add(`artifacts/account-a/${index}.png`);
    }
    bucket.values.add("artifacts/account-b/keep.png");

    await expect(deleteR2Prefix(
      bucket as unknown as R2Bucket,
      "artifacts/account-a/",
    )).resolves.toBe(1_205);
    expect([...bucket.values]).toEqual(["artifacts/account-b/keep.png"]);
  });

  it("re-purges tombstoned account prefixes during maintenance", async () => {
    const bucket = new FakeR2Bucket();
    bucket.values.add("artifacts/account-a/late.png");
    bucket.values.add("references/account-a/job/late.json");
    bucket.values.add("artifacts/account-b/keep.png");
    const env = {
      DB: {
        prepare() {
          return {
            async all() {
              return { results: [{ account_id: "account-a" }] };
            },
          };
        },
      },
      ARTIFACTS: bucket,
    } as unknown as Env;

    await purgeDeletedAccountArtifacts(env);

    expect([...bucket.values]).toEqual(["artifacts/account-b/keep.png"]);
  });
});

class FakeStatement {
  bindings: unknown[] = [];

  constructor(readonly sql: string, private readonly account: { email: string; stripe_customer_id: string | null }) {}

  bind(...values: unknown[]): this {
    this.bindings = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.sql.includes("stripe_customer_id") ? this.account as T : null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
}

class FakeD1 {
  batched: FakeStatement[] = [];
  constructor(readonly account = { email: "person@example.com", stripe_customer_id: "cus_123" }) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this.account);
  }

  async batch(statements: FakeStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.batched = statements;
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("account deletion orchestration", () => {
  it("stops Stripe billing before deleting review, artifact, session, and account data", async () => {
    const db = new FakeD1();
    const bucket = new FakeR2Bucket();
    bucket.values.add("artifacts/account-a/job.png");
    bucket.values.add("references/account-a/job/0.json");
    bucket.values.add("artifacts/account-b/keep.png");
    const reviewRequests: Request[] = [];
    const stripeRequests: Request[] = [];
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      stripeRequests.push(new Request(request, init));
      return Response.json({ id: "cus_123", deleted: true });
    });
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: bucket as unknown as R2Bucket,
      REVIEW: {
        async fetch(request: Request) {
          reviewRequests.push(request);
          return Response.json({ deleted: true, deletedObjects: 2 });
        },
      },
      STRIPE_SECRET_KEY: "stripe-secret",
    } as unknown as Env;

    const response = await deleteAccount(
      new Request("https://nibtool.com/api/account", { method: "DELETE" }),
      { id: "account-a", email: "person@example.com", sessionId: "session-a", sessionName: "Mac", platform: "macos" },
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(stripeRequests).toHaveLength(1);
    expect(stripeRequests[0]!.method).toBe("DELETE");
    expect(stripeRequests[0]!.url).toBe("https://api.stripe.com/v1/customers/cus_123");
    expect(reviewRequests).toHaveLength(1);
    expect(reviewRequests[0]!.method).toBe("DELETE");
    expect(reviewRequests[0]!.headers.get("x-nib-account-id")).toBe("account-a");
    expect([...bucket.values]).toEqual(["artifacts/account-b/keep.png"]);
    expect(db.batched.map((statement) => statement.sql)).toEqual([
      "INSERT OR IGNORE INTO deleted_accounts(account_id, deleted_at) VALUES (?, unixepoch())",
      "DELETE FROM usage_ledger WHERE account_id = ?",
      "DELETE FROM jobs WHERE account_id = ?",
      "DELETE FROM auth_sessions WHERE account_id = ?",
      "DELETE FROM auth_challenges WHERE email = ?",
      "DELETE FROM accounts WHERE account_id = ?",
    ]);
  });
});
