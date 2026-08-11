import type { Env, MeterEvent, Plan } from "./types";

export async function createCheckout(request: Request, tenantId: string, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  const plan = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")
    ? String((await request.formData()).get("plan")) as Plan
    : (await request.json<{ plan: Plan }>()).plan;
  if (plan !== "default" && plan !== "high") return Response.json({ error: "invalid plan" }, { status: 400 });
  const account = await env.DB.prepare("SELECT stripe_customer_id FROM accounts WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ stripe_customer_id: string | null }>();
  const response = await stripeRequest(
    "/v1/checkout/sessions",
    env,
    buildCheckoutForm(plan, tenantId, env, account?.stripe_customer_id ?? null),
  );
  return maybeBrowserRedirect(request, response);
}

export function buildCheckoutForm(
  plan: Plan,
  tenantId: string,
  env: Env,
  customerId: string | null,
): URLSearchParams {
  const recurringPrice = plan === "high" ? env.HIGH_PRICE_ID : env.DEFAULT_PRICE_ID;
  const form = new URLSearchParams({
    mode: "subscription",
    success_url: `${env.PUBLIC_ORIGIN}/account?checkout=success`,
    cancel_url: `${env.PUBLIC_ORIGIN}/pricing?checkout=cancelled`,
    client_reference_id: tenantId,
    billing_address_collection: "required",
    "automatic_tax[enabled]": "true",
    "tax_id_collection[enabled]": "true",
    "name_collection[individual][enabled]": "true",
    "metadata[tenant_id]": tenantId,
    "metadata[plan]": plan,
    "subscription_data[metadata][tenant_id]": tenantId,
    "subscription_data[metadata][plan]": plan,
    "line_items[0][price]": recurringPrice,
    "line_items[0][quantity]": "1",
    "line_items[1][price]": env.USAGE_PRICE_ID,
  });
  if (customerId) {
    form.set("customer", customerId);
    form.set("customer_update[address]", "auto");
    form.set("customer_update[name]", "auto");
  } else if (tenantId.includes("@")) {
    form.set("customer_email", tenantId);
  }
  return form;
}

export async function createPortal(tenantId: string, env: Env): Promise<Response> {
  const account = await env.DB.prepare("SELECT stripe_customer_id FROM accounts WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ stripe_customer_id: string | null }>();
  if (!account?.stripe_customer_id) return Response.json({ error: "billing account not found" }, { status: 404 });
  return stripeRequest(
    "/v1/billing_portal/sessions",
    env,
    buildPortalForm(account.stripe_customer_id, env),
  );
}

export function buildPortalForm(customerId: string, env: Env): URLSearchParams {
  return new URLSearchParams({
    customer: customerId,
    configuration: env.BILLING_PORTAL_CONFIGURATION_ID,
    return_url: `${env.PUBLIC_ORIGIN}/account`,
  });
}

async function maybeBrowserRedirect(request: Request, response: Response): Promise<Response> {
  if (!response.ok || !request.headers.get("accept")?.includes("text/html")) return response;
  const session = await response.clone().json<{ url?: string }>();
  return session.url ? Response.redirect(session.url, 303) : response;
}

export async function changePlan(request: Request, tenantId: string, env: Env): Promise<Response> {
  const { plan } = await request.json<{ plan: Plan }>();
  if (plan !== "default" && plan !== "high") return Response.json({ error: "invalid plan" }, { status: 400 });
  const account = await env.DB.prepare("SELECT stripe_subscription_id, stripe_recurring_item_id FROM accounts WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ stripe_subscription_id: string | null; stripe_recurring_item_id: string | null }>();
  if (!account?.stripe_subscription_id || !account.stripe_recurring_item_id) {
    return Response.json({ error: "active subscription not found" }, { status: 404 });
  }
  const price = plan === "high" ? env.HIGH_PRICE_ID : env.DEFAULT_PRICE_ID;
  const response = await stripeRequest(
    `/v1/subscriptions/${account.stripe_subscription_id}`,
    env,
    new URLSearchParams({
      "items[0][id]": account.stripe_recurring_item_id,
      "items[0][price]": price,
      "metadata[plan]": plan,
      proration_behavior: "create_prorations",
    }),
  );
  if (response.ok) {
    await env.DB.prepare("UPDATE accounts SET plan = ?, updated_at = unixepoch() WHERE tenant_id = ?").bind(plan, tenantId).run();
  }
  return response;
}

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature || !(await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response("Invalid signature", { status: 400 });
  }
  const event = JSON.parse(payload) as {
    id: string;
    type: string;
    data: { object: Record<string, unknown> };
  };
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO stripe_events(id, type, created_at) VALUES (?, ?, unixepoch())")
    .bind(event.id, event.type)
    .run();
  if (!inserted.meta.changes) return new Response("ok");
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const tenantId = String(
        session.client_reference_id ??
          (session.metadata as Record<string, string> | undefined)?.tenant_id ??
          "",
      );
      const plan =
        String(
          (session.metadata as Record<string, string> | undefined)?.plan ?? "default",
        ) === "high"
          ? "high"
          : "default";
      if (tenantId) {
        await env.DB.prepare(
          `INSERT INTO accounts(tenant_id, plan, stripe_customer_id, stripe_subscription_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
           ON CONFLICT(tenant_id) DO UPDATE SET plan = excluded.plan, stripe_customer_id = excluded.stripe_customer_id,
             stripe_subscription_id = excluded.stripe_subscription_id, updated_at = unixepoch()`,
        )
          .bind(
            tenantId,
            plan,
            String(session.customer ?? ""),
            String(session.subscription ?? ""),
          )
          .run();
      }
    }
    if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.created"
    ) {
      const subscription = event.data.object;
      const entitlement = subscriptionEntitlement(subscription, env);
      if (entitlement.tenantId) {
        await env.DB.prepare(
          `INSERT INTO accounts(
             tenant_id, plan, stripe_customer_id, stripe_subscription_id, stripe_recurring_item_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
           ON CONFLICT(tenant_id) DO UPDATE SET
             plan = excluded.plan,
             stripe_customer_id = COALESCE(excluded.stripe_customer_id, accounts.stripe_customer_id),
             stripe_subscription_id = excluded.stripe_subscription_id,
             stripe_recurring_item_id = excluded.stripe_recurring_item_id,
             updated_at = unixepoch()`,
        )
          .bind(
            entitlement.tenantId,
            entitlement.plan,
            entitlement.customerId,
            entitlement.subscriptionId,
            entitlement.recurringItemId,
          )
          .run();
      }
    }
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const metadata = subscription.metadata as Record<string, string> | undefined;
      const tenantId = metadata?.tenant_id;
      if (tenantId) {
        await env.DB.prepare(
          "UPDATE accounts SET stripe_subscription_id = NULL, stripe_recurring_item_id = NULL, updated_at = unixepoch() WHERE tenant_id = ?",
        )
          .bind(tenantId)
          .run();
      } else {
        await env.DB.prepare(
          "UPDATE accounts SET stripe_subscription_id = NULL, stripe_recurring_item_id = NULL, updated_at = unixepoch() WHERE stripe_subscription_id = ?",
        )
          .bind(String(subscription.id ?? ""))
          .run();
      }
    }
    return new Response("ok");
  } catch (error) {
    await env.DB.prepare("DELETE FROM stripe_events WHERE id = ?")
      .bind(event.id)
      .run();
    throw error;
  }
}

export function isActiveSubscriptionStatus(status: string): boolean {
  return status === "active" || status === "trialing";
}

export function subscriptionEntitlement(
  subscription: Record<string, unknown>,
  env: Env,
): {
  tenantId: string | undefined;
  plan: Plan;
  customerId: string | null;
  subscriptionId: string | null;
  recurringItemId: string | null;
} {
  const metadata = subscription.metadata as Record<string, string> | undefined;
  const items = (
    subscription.items as
      | {
          data?: Array<{
            id?: string;
            price?: {
              id?: string;
              recurring?: { usage_type?: string };
            };
          }>;
        }
      | undefined
  )?.data ?? [];
  const recurringItem = items.find(
    (item) => item.price?.recurring?.usage_type !== "metered",
  );
  const plan: Plan =
    metadata?.plan === "high" || recurringItem?.price?.id === env.HIGH_PRICE_ID
      ? "high"
      : "default";
  const active = isActiveSubscriptionStatus(String(subscription.status ?? ""));
  const customerId = String(subscription.customer ?? "").trim() || null;
  return {
    tenantId: metadata?.tenant_id,
    plan,
    customerId,
    subscriptionId: active ? String(subscription.id ?? "") || null : null,
    recurringItemId: active ? recurringItem?.id ?? null : null,
  };
}

export async function consumeMetering(batch: MessageBatch<MeterEvent>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const event = message.body;
      const response = await stripeRequest(
        "/v1/billing/meter_events",
        env,
        new URLSearchParams({
          event_name: "nib_usage_cents",
          identifier: event.identifier,
          "payload[stripe_customer_id]": event.stripeCustomerId,
          "payload[value]": String(event.value),
        }),
      );
      if (!response.ok) throw new Error(await response.text());
      await env.DB.prepare("UPDATE usage_ledger SET state = 'sent', sent_at = unixepoch() WHERE identifier = ?")
        .bind(event.identifier)
        .run();
      message.ack();
    } catch {
      message.retry();
    }
  }
}

async function stripeRequest(path: string, env: Env, body: URLSearchParams): Promise<Response> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  const fields = new Map(header.split(",").map((field) => field.split("=", 2) as [string, string]));
  const timestamp = fields.get("t");
  const signature = fields.get("v1");
  if (!timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return difference === 0;
}
