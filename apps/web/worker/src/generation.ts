import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { MODEL_BY_QUALITY, PLAN_LIMITS, usageCents } from "./rate-card";
import { trialRequestError } from "./trial-policy";
import type { BillingMode, Env, GenerationRequest, Plan, ReferenceImage, StoredGenerationRequest } from "./types";
import { validateGenerationRequest } from "./validation";

const uiPromptPrefix = `Generate exactly one raw user-interface viewport image. Show only the interface itself: no device frame, browser chrome, annotations, review marks, score, comparison, or surrounding scene. Use legible interface copy, coherent spacing, production-quality hierarchy, and a complete viewport composition.\n\nUI brief:\n`;

export async function handleGeneration(request: Request, env: Env): Promise<Response> {
  const tenantId = request.headers.get("x-nib-tenant");
  if (!tenantId) return Response.json({ error: "missing trusted tenant context" }, { status: 401 });
  let input: GenerationRequest;
  try {
    input = await request.json<GenerationRequest>();
  } catch {
    return Response.json({ error: "invalid JSON request body" }, { status: 400 });
  }
  if (input.resume_job_id) return resumeGeneration(tenantId, input.resume_job_id, env);
  const validation = validateGenerationRequest(input);
  if (validation) return Response.json({ error: validation }, { status: 400 });

  const account = await accountFor(tenantId, env);
  const jobId = crypto.randomUUID();
  const billingMode: BillingMode = env.ENVIRONMENT !== "production" || account.stripeSubscriptionId ? "paid" : "trial";
  let trialReserved = false;
  if (env.ENVIRONMENT === "production" && billingMode === "trial") {
    const shapeError = trialRequestError(input);
    if (shapeError) return trialError(shapeError, env);
    if (account.trialState !== "available") return trialError("FREE_TRIAL_USED", env);
    const networkHash = request.headers.get("x-nib-trial-network");
    if (!networkHash) return trialError("FREE_TRIAL_NETWORK_REQUIRED", env, 403);
    const trialGate = env.TRIAL_GATE.get(env.TRIAL_GATE.idFromName("global"));
    const claim = await trialGate.fetch("https://trial/claim", {
      method: "POST",
      body: JSON.stringify({ tenantId, networkHash }),
    });
    if (!claim.ok) {
      const body: { error?: string } = await claim.json<{ error?: string }>().catch(() => ({}));
      return trialError(body.error ?? "FREE_TRIAL_UNAVAILABLE", env, claim.status);
    }
    const reserved = await env.DB.prepare(
      `UPDATE accounts
       SET trial_state = 'reserved', trial_job_id = ?, trial_started_at = COALESCE(trial_started_at, unixepoch()), updated_at = unixepoch()
       WHERE tenant_id = ? AND trial_state = 'available' AND stripe_subscription_id IS NULL`,
    )
      .bind(jobId, tenantId)
      .run();
    if (!reserved.meta.changes) return trialError("FREE_TRIAL_USED", env);
    trialReserved = true;
  }
  const gate = env.TENANT_GATE.get(env.TENANT_GATE.idFromName(tenantId));
  const acquired = await gate.fetch("https://gate/acquire", {
    method: "POST",
    body: JSON.stringify({ plan: account.plan, background: input.background }),
  });
  if (!acquired.ok) {
    if (trialReserved) await releaseTrial(tenantId, jobId, env);
    return new Response(acquired.body, acquired);
  }

  let referenceKeys: string[] = [];
  let handedToWorkflow = false;
  let completed = false;
  try {
    referenceKeys = await storeReferences(tenantId, jobId, input.references, env);
    const stored: StoredGenerationRequest = {
      prompt: input.prompt?.trim(),
      resume_job_id: undefined,
      quality: input.quality,
      aspect: input.aspect,
      resolution: input.resolution,
      format: input.format,
      background: input.background,
      tenantId,
      jobId,
      referenceKeys,
      usageCents: usageCents(input.quality, input.resolution),
      model: MODEL_BY_QUALITY[input.quality],
      plan: account.plan,
      billingMode,
    };
    await env.DB.prepare(
      `INSERT INTO jobs(id, tenant_id, status, model, quality, resolution, format, aspect, usage_cents, billing_mode, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
    )
      .bind(jobId, tenantId, stored.model, input.quality, input.resolution, input.format, input.aspect, stored.usageCents, billingMode)
      .run();

    if (input.background) {
      const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName("global"));
      await scheduler.fetch("https://scheduler/enqueue", {
        method: "POST",
        body: JSON.stringify(stored),
      });
      handedToWorkflow = true;
      return Response.json(responseMetadata(stored, "queued", undefined, undefined));
    }

    const result = await performGeneration(stored, env);
    completed = true;
    if (trialReserved) await consumeTrial(tenantId, jobId, env);
    return Response.json(result);
  } catch (error) {
    console.error("generation failed", { jobId, error });
    await env.DB.prepare("UPDATE jobs SET status = 'failed', error_code = ?, updated_at = unixepoch() WHERE id = ?")
      .bind(error instanceof Error ? error.name : "GENERATION_FAILED", jobId)
      .run();
    return Response.json({ error: "GENERATION_FAILED", job_id: jobId }, { status: 502 });
  } finally {
    if (!handedToWorkflow) {
      await deleteReferences(referenceKeys, env);
      await gate.fetch("https://gate/release", { method: "POST", body: JSON.stringify({ plan: account.plan, background: false }) });
      if (trialReserved && !completed) await releaseTrial(tenantId, jobId, env);
    }
  }
}

export class GenerationWorkflow extends WorkflowEntrypoint<Env, StoredGenerationRequest> {
  async run(event: WorkflowEvent<StoredGenerationRequest>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    const gate = this.env.TENANT_GATE.get(this.env.TENANT_GATE.idFromName(input.tenantId));
    try {
      await step.do("generate UI image", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => {
        await performGeneration(input, this.env);
      });
    } catch (error) {
      await this.env.DB.prepare("UPDATE jobs SET status = 'failed', error_code = ?, updated_at = unixepoch() WHERE id = ?")
        .bind(error instanceof Error ? error.name : "GENERATION_FAILED", input.jobId)
        .run();
      throw error;
    } finally {
      await deleteReferences(input.referenceKeys, this.env);
      await gate.fetch("https://gate/release", { method: "POST", body: JSON.stringify({ plan: input.plan, background: true }) });
    }
  }
}

async function performGeneration(input: StoredGenerationRequest, env: Env): Promise<Record<string, unknown>> {
  await env.DB.prepare("UPDATE jobs SET status = 'running', updated_at = unixepoch() WHERE id = ?").bind(input.jobId).run();
  const references = await loadReferences(input.referenceKeys, env);
  const modelInput: Record<string, unknown> = {
    prompt: `${uiPromptPrefix}${input.prompt}`,
    aspect_ratio: input.aspect,
    output_format: input.format,
    image_input: references.map((reference) => `data:${reference.mime_type};base64,${reference.data}`),
  };
  if (input.quality === "standard") modelInput.resolution = input.resolution;
  if (input.quality === "pro") modelInput.image_size = input.resolution;

  const aiResponse = (await env.AI.run(input.model as Parameters<Ai["run"]>[0], modelInput, {
    gateway: {
      id: env.AI_GATEWAY_ID,
      skipCache: true,
      collectLog: false,
      metadata: { tenant: input.tenantId, job: input.jobId, billing_mode: input.billingMode },
    },
  } as never)) as unknown as { result?: { image?: string }; image?: string };
  const imageUrl = aiResponse.result?.image ?? aiResponse.image;
  if (!imageUrl) throw new Error("AI response did not contain an image URL");
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error(`generated image fetch failed: ${imageResponse.status}`);
  const bytes = await imageResponse.arrayBuffer();
  const mimeType = input.format === "png" ? "image/png" : "image/jpeg";
  const key = `artifacts/${input.tenantId}/${input.jobId}.${input.format}`;
  const retention = input.billingMode === "trial" ? 1 : PLAN_LIMITS[input.plan].retentionDays;
  await env.ARTIFACTS.put(key, bytes, {
    httpMetadata: { contentType: mimeType, cacheControl: "private, max-age=300" },
    customMetadata: { tenantId: input.tenantId, jobId: input.jobId, expiresAt: new Date(Date.now() + retention * 86_400_000).toISOString() },
  });
  await env.DB.prepare(
    "UPDATE jobs SET status = 'succeeded', artifact_key = ?, expires_at = unixepoch() + ?, updated_at = unixepoch() WHERE id = ?",
  )
    .bind(key, retention * 86_400, input.jobId)
    .run();
  if (input.billingMode === "paid") await recordUsage(input, env);
  return responseMetadata(input, "succeeded", `${env.PUBLIC_ORIGIN}/artifacts/${input.jobId}`, {
    data: arrayBufferToBase64(bytes),
    mime_type: mimeType,
  });
}

async function recordUsage(input: StoredGenerationRequest, env: Env): Promise<void> {
  const account = await accountFor(input.tenantId, env);
  const identifier = `nib_${input.jobId}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO usage_ledger(identifier, tenant_id, job_id, usage_cents, state, created_at)
     VALUES (?, ?, ?, ?, 'queued', unixepoch())`,
  )
    .bind(identifier, input.tenantId, input.jobId, input.usageCents)
    .run();
  if (account.stripeCustomerId) {
    await env.METERING_QUEUE.send({
      identifier,
      tenantId: input.tenantId,
      stripeCustomerId: account.stripeCustomerId,
      value: input.usageCents,
    });
  }
}

async function resumeGeneration(tenantId: string, jobId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id, status, model, quality, resolution, format, aspect, usage_cents, billing_mode, artifact_key, error_code FROM jobs WHERE id = ? AND tenant_id = ?",
  )
    .bind(jobId, tenantId)
    .first<Record<string, string | number | null>>();
  if (!row) return Response.json({ error: "job not found" }, { status: 404 });
  let image: { data: string; mime_type: string } | undefined;
  let artifactUrl: string | undefined;
  if (row.status === "succeeded" && typeof row.artifact_key === "string") {
    const object = await env.ARTIFACTS.get(row.artifact_key);
    if (object) {
      image = { data: arrayBufferToBase64(await object.arrayBuffer()), mime_type: object.httpMetadata?.contentType ?? "image/png" };
      artifactUrl = `${env.PUBLIC_ORIGIN}/artifacts/${jobId}`;
    }
  }
  return Response.json({
    job_id: row.id,
    status: row.status,
    model: row.model,
    quality: row.quality,
    resolution: row.resolution,
    format: row.format,
    aspect: row.aspect,
    usage_cents: row.usage_cents,
    billing_mode: row.billing_mode,
    trial_remaining: row.billing_mode === "trial" ? 0 : null,
    artifact_url: artifactUrl,
    image,
    output_path: null,
    error_code: row.error_code,
  });
}

export async function artifactResponse(request: Request, tenantId: string, jobId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT artifact_key FROM jobs WHERE id = ? AND tenant_id = ? AND status = 'succeeded'")
    .bind(jobId, tenantId)
    .first<{ artifact_key: string }>();
  if (!row) return new Response("Not found", { status: 404 });
  const object = await env.ARTIFACTS.get(row.artifact_key, { range: request.headers });
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=300");
  return new Response(object.body, { headers });
}

async function accountFor(
  tenantId: string,
  env: Env,
): Promise<{ plan: Plan; stripeCustomerId: string | null; stripeSubscriptionId: string | null; trialState: string }> {
  const account = await env.DB.prepare("SELECT plan, stripe_customer_id, stripe_subscription_id, trial_state FROM accounts WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ plan: Plan; stripe_customer_id: string | null; stripe_subscription_id: string | null; trial_state: string }>();
  if (!account) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO accounts(tenant_id, plan, created_at, updated_at) VALUES (?, 'default', unixepoch(), unixepoch())",
    )
      .bind(tenantId)
      .run();
  }
  return {
    plan: account?.plan ?? "default",
    stripeCustomerId: account?.stripe_customer_id ?? null,
    stripeSubscriptionId: account?.stripe_subscription_id ?? null,
    trialState: account?.trial_state ?? "available",
  };
}

async function consumeTrial(tenantId: string, jobId: string, env: Env): Promise<void> {
  const consumed = await env.DB.prepare(
    `UPDATE accounts SET trial_state = 'used', updated_at = unixepoch()
     WHERE tenant_id = ? AND trial_state = 'reserved' AND trial_job_id = ?`,
  )
    .bind(tenantId, jobId)
    .run();
  if (!consumed.meta.changes) throw new Error("trial reservation was not consumable");
}

async function releaseTrial(tenantId: string, jobId: string, env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE accounts SET trial_state = 'available', trial_job_id = NULL, updated_at = unixepoch()
     WHERE tenant_id = ? AND trial_state = 'reserved' AND trial_job_id = ?`,
  )
    .bind(tenantId, jobId)
    .run();
}

function trialError(code: string, env: Env, status = 402): Response {
  const messages: Record<string, string> = {
    FREE_TRIAL_FAST_1K_ONLY: "The free trial generates one Fast 1K image. Choose Fast and 1K, or subscribe for Standard and Pro.",
    FREE_TRIAL_BLOCKING_ONLY: "The free trial runs as a blocking request. Remove the background option, or subscribe for queued generation.",
    FREE_TRIAL_USED: "This verified identity has used its free image. Subscribe to continue generating UI visualizations.",
    FREE_TRIAL_NETWORK_REQUIRED: "The free trial requires a verifiable Cloudflare network context. Sign in and retry, or subscribe.",
    FREE_TRIAL_NETWORK_LIMIT: "This network has reached its free-trial identity limit. Subscribe to continue generating UI visualizations.",
    FREE_TRIAL_DAILY_LIMIT: "Today's free-trial capacity is full. Subscribe now or try again after 00:00 UTC.",
  };
  return Response.json(
    {
      error: code,
      message: messages[code] ?? "The free trial is unavailable.",
      upgrade_url: `${env.PUBLIC_ORIGIN}/pricing`,
    },
    { status },
  );
}

async function storeReferences(tenantId: string, jobId: string, references: ReferenceImage[], env: Env): Promise<string[]> {
  const keys: string[] = [];
  for (const [index, reference] of references.entries()) {
    const key = `references/${tenantId}/${jobId}/${index}.json`;
    await env.ARTIFACTS.put(key, JSON.stringify(reference), { customMetadata: { temporary: "true" } });
    keys.push(key);
  }
  return keys;
}

async function loadReferences(keys: string[], env: Env): Promise<ReferenceImage[]> {
  const references: ReferenceImage[] = [];
  for (const key of keys) {
    const object = await env.ARTIFACTS.get(key);
    if (!object) throw new Error(`missing reference ${key}`);
    references.push(await object.json<ReferenceImage>());
  }
  return references;
}

async function deleteReferences(keys: string[], env: Env): Promise<void> {
  await Promise.all(keys.map((key) => env.ARTIFACTS.delete(key)));
}

export async function runMaintenance(env: Env): Promise<void> {
  const expired = await env.DB.prepare(
    "SELECT id, artifact_key FROM jobs WHERE artifact_key IS NOT NULL AND expires_at <= unixepoch() LIMIT 500",
  ).all<{ id: string; artifact_key: string }>();
  await Promise.all(expired.results.map((job) => env.ARTIFACTS.delete(job.artifact_key)));
  if (expired.results.length) {
    const statements = expired.results.map((job) =>
      env.DB.prepare("UPDATE jobs SET artifact_key = NULL, updated_at = unixepoch() WHERE id = ?").bind(job.id),
    );
    await env.DB.batch(statements);
  }

  const pending = await env.DB.prepare(
    `SELECT l.identifier, l.tenant_id, l.usage_cents, a.stripe_customer_id
     FROM usage_ledger l JOIN accounts a ON a.tenant_id = l.tenant_id
     WHERE l.state = 'queued' AND l.created_at <= unixepoch() - 300 AND a.stripe_customer_id IS NOT NULL
     LIMIT 500`,
  ).all<{ identifier: string; tenant_id: string; usage_cents: number; stripe_customer_id: string }>();
  await Promise.all(
    pending.results.map((entry) =>
      env.METERING_QUEUE.send({
        identifier: entry.identifier,
        tenantId: entry.tenant_id,
        stripeCustomerId: entry.stripe_customer_id,
        value: entry.usage_cents,
      }),
    ),
  );
}

function responseMetadata(input: StoredGenerationRequest, status: string, artifactUrl?: string, image?: { data: string; mime_type: string }): Record<string, unknown> {
  return {
    job_id: input.jobId,
    status,
    model: input.model,
    quality: input.quality,
    aspect: input.aspect,
    resolution: input.resolution,
    format: input.format,
    usage_cents: input.usageCents,
    billing_mode: input.billingMode,
    trial_remaining: input.billingMode === "trial" ? 0 : null,
    artifact_url: artifactUrl ?? null,
    image: image ?? null,
    output_path: null,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
