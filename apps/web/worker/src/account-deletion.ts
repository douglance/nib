import { expiredSessionCookie, type NibAccount } from "./account-auth";
import type { Env } from "./types";

export async function deleteAccount(
  request: Request,
  account: NibAccount,
  env: Env,
): Promise<Response> {
  try {
    const stored = await env.DB.prepare(
      "SELECT email, stripe_customer_id FROM accounts WHERE account_id = ?",
    ).bind(account.id).first<{ email: string; stripe_customer_id: string | null }>();
    if (!stored) return accountDeletionResponse(request, 404, { error: "account_not_found" });

    if (stored.stripe_customer_id) {
      await deleteStripeCustomer(stored.stripe_customer_id, env);
    }

    const reviewResponse = await env.REVIEW.fetch(new Request("https://nib.internal/api/account", {
      method: "DELETE",
      headers: { "x-nib-account-id": account.id },
    }));
    if (!reviewResponse.ok) throw new Error(`review deletion failed: ${reviewResponse.status}`);

    await Promise.all([
      deleteR2Prefix(env.ARTIFACTS, `artifacts/${account.id}/`),
      deleteR2Prefix(env.ARTIFACTS, `references/${account.id}/`),
    ]);

    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO deleted_accounts(account_id, deleted_at) VALUES (?, unixepoch())").bind(account.id),
      env.DB.prepare("DELETE FROM usage_ledger WHERE account_id = ?").bind(account.id),
      env.DB.prepare("DELETE FROM jobs WHERE account_id = ?").bind(account.id),
      env.DB.prepare("DELETE FROM auth_sessions WHERE account_id = ?").bind(account.id),
      env.DB.prepare("DELETE FROM auth_challenges WHERE email = ?").bind(stored.email),
      env.DB.prepare("DELETE FROM accounts WHERE account_id = ?").bind(account.id),
    ]);

    return accountDeletionResponse(request, 200, { deleted: true });
  } catch (error) {
    console.error("Nib account deletion failed", error instanceof Error ? error.message : "unknown error");
    return accountDeletionResponse(request, 502, { error: "account_deletion_failed" });
  }
}

export async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  while (true) {
    const page = await bucket.list({ prefix, limit: 1_000 });
    const keys = page.objects.map((object) => object.key);
    if (!keys.length) return deleted;
    await bucket.delete(keys);
    deleted += keys.length;
  }
}

export async function purgeDeletedAccountArtifacts(env: Env): Promise<void> {
  const deleted = await env.DB.prepare("SELECT account_id FROM deleted_accounts")
    .all<{ account_id: string }>();
  for (const account of deleted.results) {
    await Promise.all([
      deleteR2Prefix(env.ARTIFACTS, `artifacts/${account.account_id}/`),
      deleteR2Prefix(env.ARTIFACTS, `references/${account.account_id}/`),
    ]);
  }
}

async function deleteStripeCustomer(customerId: string, env: Env): Promise<void> {
  const response = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (response.ok) return;
  if (response.status === 404) {
    let body: { error?: { code?: string } } = {};
    try {
      body = await response.clone().json<{ error?: { code?: string } }>();
    } catch {
      // A non-JSON 404 is still an error; only Stripe's resource_missing is idempotent.
    }
    if (body.error?.code === "resource_missing") return;
  }
  throw new Error(`Stripe customer deletion failed: ${response.status}`);
}

function accountDeletionResponse(
  request: Request,
  status: number,
  body: { deleted: true } | { error: string },
): Response {
  const headers = new Headers({
    "cache-control": "private, no-store",
    "set-cookie": expiredSessionCookie(),
  });
  if (status === 200 && request.headers.get("accept")?.includes("text/html")) {
    headers.set("location", "/?account=deleted");
    return new Response(null, { status: 303, headers });
  }
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}
