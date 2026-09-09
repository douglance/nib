import type { Env, Plan } from "./types";

interface BillingAccount {
  account_id: string;
  email: string;
  stripe_customer_id: string | null;
  stripe_billing_event_id: string | null;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const subscriptionEvents = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature || !(await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response("Invalid signature", { status: 400 });
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(payload);
    if (typeof event?.id !== "string" || !event.id || typeof event.type !== "string" || !event.data?.object) {
      return new Response("Invalid event", { status: 400 });
    }
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!subscriptionEvents.has(event.type) || await processed(event.id, env)) return new Response("ok");

  const object = event.data.object;
  const metadata = object.metadata as Record<string, string> | undefined;
  const reference = String(object.client_reference_id ?? metadata?.account_id ?? metadata?.tenant_id ?? "").trim();
  const customerId = stripeId(object.customer);
  if (!customerId) return new Response("Missing customer", { status: 400 });
  const account = reference
    ? await env.DB.prepare(
        "SELECT account_id, email, stripe_customer_id, stripe_billing_event_id FROM accounts WHERE account_id = ? OR email = lower(?) LIMIT 1",
      ).bind(reference, reference).first<BillingAccount>()
    : await env.DB.prepare(
        "SELECT account_id, email, stripe_customer_id, stripe_billing_event_id FROM accounts WHERE stripe_customer_id = ? LIMIT 1",
      ).bind(customerId).first<BillingAccount>();
  if (!account) return new Response("ok");
  if (account.stripe_customer_id && account.stripe_customer_id !== customerId) {
    return new Response("Customer does not match account", { status: 409 });
  }

  const subscription = await currentSubscription(customerId, account, env);
  const entitlement = subscriptionEntitlement(subscription ?? { customer: customerId }, env);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
         stripe_recurring_item_id = ?, stripe_billing_event_id = ?, updated_at = unixepoch()
       WHERE account_id = ? AND stripe_billing_event_id IS ?
         AND NOT EXISTS (SELECT 1 FROM stripe_events WHERE id = ?)`,
    ).bind(entitlement.plan, customerId, entitlement.subscriptionId, entitlement.recurringItemId,
      event.id, account.account_id, account.stripe_billing_event_id, event.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO stripe_events(id, type, created_at)
       SELECT ?, ?, unixepoch() WHERE EXISTS (
         SELECT 1 FROM accounts WHERE account_id = ? AND stripe_billing_event_id = ?
       )`,
    ).bind(event.id, event.type, account.account_id, event.id),
  ]);
  if (!(await processed(event.id, env))) {
    // Another webhook committed while Stripe was being read. Retry from a fresh
    // account snapshot instead of acknowledging a stale result.
    throw new Error("Billing changed during reconciliation; retry the event");
  }
  return new Response("ok");
}

async function processed(id: string, env: Env): Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT id FROM stripe_events WHERE id = ?").bind(id).first());
}

async function currentSubscription(
  customerId: string,
  account: BillingAccount,
  env: Env,
): Promise<Record<string, unknown> | null> {
  const query = new URLSearchParams({ customer: customerId, status: "all", limit: "100" });
  const cursors = new Set<string>();
  let selected: Record<string, unknown> | null = null;
  for (;;) {
    const response = await fetch(`https://api.stripe.com/v1/subscriptions?${query}`, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!response.ok) throw new Error(`Stripe subscription reconciliation failed (${response.status})`);
    const page = await response.json<{ data: Record<string, unknown>[]; has_more: boolean }>();
    if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
      throw new Error("Invalid Stripe subscription list");
    }
    for (const candidate of page.data) {
      const entitlement = subscriptionEntitlement(candidate, env);
      const reference = entitlement.tenantId?.trim().toLowerCase();
      if (!entitlement.subscriptionId || entitlement.customerId !== customerId ||
          (reference && reference !== account.account_id && reference !== account.email.toLowerCase())) continue;
      if (!selected || Number(candidate.created ?? 0) > Number(selected.created ?? 0)) selected = candidate;
    }
    if (!page.has_more) return selected;
    const cursor = stripeId(page.data.at(-1));
    if (!cursor || cursors.has(cursor)) throw new Error("Invalid Stripe subscription pagination");
    cursors.add(cursor);
    query.set("starting_after", cursor);
  }
}

function stripeId(value: unknown): string | null {
  const id = typeof value === "string" ? value : (value as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function isActiveSubscriptionStatus(status: string): boolean {
  return status === "active" || status === "trialing";
}

export function subscriptionEntitlement(subscription: Record<string, unknown>, env: Env): {
  tenantId: string | undefined;
  plan: Plan;
  customerId: string | null;
  subscriptionId: string | null;
  recurringItemId: string | null;
} {
  const metadata = subscription.metadata as Record<string, string> | undefined;
  const items = (subscription.items as { data?: Array<{
    id?: string;
    price?: { id?: string; recurring?: { usage_type?: string } };
  }> } | undefined)?.data ?? [];
  const recurring = items.find((item) =>
    item.price?.recurring?.usage_type === "licensed" &&
    (item.price.id === env.DEFAULT_PRICE_ID || item.price.id === env.HIGH_PRICE_ID));
  const usage = items.find((item) => item.price?.id === env.USAGE_PRICE_ID &&
    item.price.recurring?.usage_type === "metered");
  const customerId = stripeId(subscription.customer);
  const active = isActiveSubscriptionStatus(String(subscription.status ?? "")) &&
    Boolean(customerId && recurring?.id && usage?.id);
  return {
    tenantId: metadata?.account_id ?? metadata?.tenant_id,
    plan: recurring?.price?.id === env.HIGH_PRICE_ID ? "high" : "default",
    customerId,
    subscriptionId: active ? stripeId(subscription.id) : null,
    recurringItemId: active ? recurring?.id ?? null : null,
  };
}

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  const fields = header.split(",").map((field) => field.trim().split("=", 2));
  const timestamp = fields.find(([name]) => name === "t")?.[1];
  const signatures = fields.filter(([name]) => name === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return signatures.some((signature) => {
    if (!signature || expected.length !== signature.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
    return difference === 0;
  });
}
