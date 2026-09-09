import type { Env, MeterEvent, Plan } from "./types";

const STRIPE_IDEMPOTENCY_REPLAY_SECONDS = 23 * 60 * 60;

export async function createCheckout(request: Request, tenantId: string, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  const plan = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")
    ? String((await request.formData()).get("plan")) as Plan
    : (await request.json<{ plan: Plan }>()).plan;
  if (plan !== "default" && plan !== "high") return Response.json({ error: "invalid plan" }, { status: 400 });
  const account = await env.DB.prepare("SELECT email, stripe_customer_id FROM accounts WHERE account_id = ?")
    .bind(tenantId)
    .first<{ email: string; stripe_customer_id: string | null }>();
  if (!account) return Response.json({ error: "account not found" }, { status: 404 });
  const response = await stripeRequest(
    "/v1/checkout/sessions",
    env,
    buildCheckoutForm(plan, tenantId, env, account.stripe_customer_id, account.email),
  );
  return maybeBrowserRedirect(request, response);
}

export function buildCheckoutForm(
  plan: Plan,
  tenantId: string,
  env: Env,
  customerId: string | null,
  email?: string,
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
    "metadata[account_id]": tenantId,
    "metadata[plan]": plan,
    "subscription_data[metadata][account_id]": tenantId,
    "subscription_data[metadata][plan]": plan,
    "line_items[0][price]": recurringPrice,
    "line_items[0][quantity]": "1",
    "line_items[1][price]": env.USAGE_PRICE_ID,
  });
  if (customerId) {
    form.set("customer", customerId);
    form.set("customer_update[address]", "auto");
    form.set("customer_update[name]", "auto");
  } else if (email) {
    form.set("customer_email", email);
  }
  return form;
}

export async function createPortal(tenantId: string, env: Env, request: Request): Promise<Response> {
  const configuration = env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
  if (!configuration) return Response.json({ error: "billing portal is not configured" }, { status: 503 });
  const account = await env.DB.prepare("SELECT stripe_customer_id FROM accounts WHERE account_id = ?")
    .bind(tenantId)
    .first<{ stripe_customer_id: string | null }>();
  if (!account?.stripe_customer_id) return Response.json({ error: "billing account not found" }, { status: 404 });
  const response = await stripeRequest(
    "/v1/billing_portal/sessions",
    env,
    new URLSearchParams({ customer: account.stripe_customer_id, return_url: `${env.PUBLIC_ORIGIN}/account`, configuration }),
  );
  return maybeBrowserRedirect(request, response);
}

async function maybeBrowserRedirect(request: Request, response: Response): Promise<Response> {
  if (!response.ok || !request.headers.get("accept")?.includes("text/html")) return response;
  const session = await response.clone().json<{ url?: string }>();
  return session.url ? Response.redirect(session.url, 303) : response;
}

export async function changePlan(request: Request, tenantId: string, env: Env): Promise<Response> {
  let plan: unknown;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    plan = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")
      ? (await request.formData()).get("plan")
      : (await request.json<{ plan?: unknown } | null>())?.plan;
  } catch {
    return planChangeResponse(request, env, "invalid", Response.json({ error: "invalid plan" }, { status: 400 }));
  }
  if (plan !== "default" && plan !== "high") {
    return planChangeResponse(request, env, "invalid", Response.json({ error: "invalid plan" }, { status: 400 }));
  }
  const account = await env.DB.prepare("SELECT stripe_subscription_id, stripe_recurring_item_id FROM accounts WHERE account_id = ?")
    .bind(tenantId)
    .first<{ stripe_subscription_id: string | null; stripe_recurring_item_id: string | null }>();
  if (!account?.stripe_subscription_id || !account.stripe_recurring_item_id) {
    return planChangeResponse(request, env, "no_subscription", Response.json({ error: "active subscription not found" }, { status: 404 }));
  }
  const price = plan === "high" ? env.HIGH_PRICE_ID : env.DEFAULT_PRICE_ID;
  try {
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
    const outcome = response.ok ? "submitted" : response.status >= 500 ? "unknown" : "failed";
    return planChangeResponse(request, env, outcome, response, response.ok ? plan : undefined);
  } catch {
    // The request may have reached Stripe. Reconcile through the webhook/status
    // path before encouraging a customer to submit the same change again.
    return planChangeResponse(request, env, "unknown", Response.json({ error: "plan change outcome unknown" }, { status: 502 }));
  }
}

function planChangeResponse(
  request: Request,
  env: Env,
  outcome: "submitted" | "invalid" | "no_subscription" | "failed" | "unknown",
  response: Response,
  plan?: Plan,
): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  if (!request.headers.get("accept")?.includes("text/html")) {
    return new Response(response.body, { status: response.status, headers });
  }
  const destination = new URL("/account", env.PUBLIC_ORIGIN);
  destination.searchParams.set("plan_change", outcome);
  if (plan) destination.searchParams.set("plan", plan);
  return new Response(null, { status: 303, headers: {
    location: destination.toString(), "cache-control": "private, no-store",
  } });
}

export async function billingStatus(tenantId: string, env: Env): Promise<Response> {
  const account = await env.DB.prepare(
    "SELECT plan, stripe_customer_id, stripe_subscription_id, stripe_recurring_item_id FROM accounts WHERE account_id = ?",
  ).bind(tenantId).first<{
    plan: Plan; stripe_customer_id: string | null;
    stripe_subscription_id: string | null; stripe_recurring_item_id: string | null;
  }>();
  const headers = { "cache-control": "private, no-store" };
  if (!account) return Response.json({ error: "account not found" }, { status: 404, headers });
  return Response.json({
    subscribed: Boolean(account.stripe_customer_id && account.stripe_subscription_id && account.stripe_recurring_item_id),
    plan: account.plan,
    hasBillingCustomer: Boolean(account.stripe_customer_id),
  }, { headers });
}

export { handleStripeWebhook, isActiveSubscriptionStatus, subscriptionEntitlement } from "./billing-webhook";

interface UsageLedgerRow {
  identifier: string;
  account_id: string;
  usage_cents: number;
  state: "queued" | "sent";
  created_at: number;
  first_attempt_at: number | null;
  stripe_event_name: string | null;
  stripe_customer_id: string | null;
  stripe_value: number | null;
  stripe_event_timestamp: number | null;
  reconciliation_required: number;
  account_stripe_customer_id: string | null;
}

export async function consumeMetering(batch: MessageBatch<MeterEvent>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const eventName = env.STRIPE_USAGE_EVENT_NAME?.trim();
      if (!eventName) throw new Error("Stripe usage meter event name is not configured");
      const identifier = message.body.identifier?.trim();
      if (!identifier) {
        message.ack();
        continue;
      }
      let ledger = await meteringLedger(identifier, env);
      if (!ledger || ledger.state === "sent" || ledger.reconciliation_required === 1) {
        message.ack();
        continue;
      }
      if (ledger.first_attempt_at === null) {
        ledger = await freezeMeteringAttempt(ledger, eventName, env);
      }
      if (!ledger || ledger.state === "sent" || ledger.reconciliation_required === 1) {
        message.ack();
        continue;
      }
      if (!ledger.stripe_event_name || !ledger.stripe_customer_id || ledger.stripe_value === null || ledger.stripe_event_timestamp === null) {
        await holdMeteringForReconciliation(identifier, env);
        message.ack();
        continue;
      }
      if (isOutsideStripeReplayWindow(ledger.first_attempt_at)) {
        await holdMeteringForReconciliation(identifier, env);
        message.ack();
        continue;
      }
      const response = await stripeRequest(
        "/v1/billing/meter_events",
        env,
        new URLSearchParams({
          event_name: ledger.stripe_event_name,
          identifier: ledger.identifier,
          timestamp: String(ledger.stripe_event_timestamp),
          "payload[stripe_customer_id]": ledger.stripe_customer_id,
          "payload[value]": String(ledger.stripe_value),
        }),
        { idempotencyKey: `nib-meter-${ledger.identifier}` },
      );
      if (!response.ok) {
        const body = await response.text();
        if (body.includes("already exists with identifier")) {
          await holdMeteringForReconciliation(identifier, env);
          message.ack();
          continue;
        }
        throw new Error(body);
      }
      const markedSent = await env.DB.prepare(
        `UPDATE usage_ledger SET state = 'sent', sent_at = unixepoch()
         WHERE identifier = ? AND state = 'queued' AND first_attempt_at = ? AND reconciliation_required = 0`,
      )
        .bind(identifier, ledger.first_attempt_at)
        .run();
      if (!markedSent.meta.changes) {
        const latest = await meteringLedger(identifier, env);
        if (latest?.state === "sent" || latest?.reconciliation_required === 1) {
          message.ack();
          continue;
        }
        throw new Error("metering ledger send marker was not updated");
      }
      message.ack();
    } catch {
      message.retry();
    }
  }
}

async function meteringLedger(identifier: string, env: Env): Promise<UsageLedgerRow | null> {
  return env.DB.prepare(
    `SELECT l.identifier, l.account_id, l.usage_cents, l.state, l.created_at,
            l.first_attempt_at, l.stripe_event_name, l.stripe_customer_id,
            l.stripe_value, l.stripe_event_timestamp, l.reconciliation_required,
            a.stripe_customer_id AS account_stripe_customer_id
     FROM usage_ledger l
     JOIN accounts a ON a.account_id = l.account_id
     WHERE l.identifier = ?`,
  )
    .bind(identifier)
    .first<UsageLedgerRow>();
}

async function freezeMeteringAttempt(row: UsageLedgerRow, eventName: string, env: Env): Promise<UsageLedgerRow | null> {
  if (!row.account_stripe_customer_id) {
    await holdMeteringForReconciliation(row.identifier, env);
    return meteringLedger(row.identifier, env);
  }
  await env.DB.prepare(
    `UPDATE usage_ledger
     SET first_attempt_at = unixepoch(),
         stripe_event_name = ?,
         stripe_customer_id = ?,
         stripe_value = ?,
         stripe_event_timestamp = ?
     WHERE identifier = ? AND state = 'queued' AND first_attempt_at IS NULL AND reconciliation_required = 0`,
  )
    .bind(eventName, row.account_stripe_customer_id, row.usage_cents, row.created_at, row.identifier)
    .run();
  return meteringLedger(row.identifier, env);
}

async function holdMeteringForReconciliation(identifier: string, env: Env): Promise<void> {
  await env.DB.prepare("UPDATE usage_ledger SET reconciliation_required = 1 WHERE identifier = ? AND state = 'queued'")
    .bind(identifier)
    .run();
}

function isOutsideStripeReplayWindow(firstAttemptAt: number | null): boolean {
  return firstAttemptAt === null || firstAttemptAt <= Math.floor(Date.now() / 1000) - STRIPE_IDEMPOTENCY_REPLAY_SECONDS;
}

async function stripeRequest(
  path: string,
  env: Env,
  body: URLSearchParams,
  options: { idempotencyKey?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers,
    body,
  });
  return new Response(response.body, { status: response.status, headers: response.headers });
}
