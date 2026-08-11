import type { Env } from "./types";

export interface CloudflareUsageRecord {
  ChargePeriodStart?: string;
  ConsumedQuantity?: number;
  ConsumedUnit?: string;
  BilledCost?: number;
  EffectiveCost?: number;
  BillingCurrency?: string;
  x_BillableMetricId?: string;
  x_ProductFamilyName?: string;
}

export interface CloudflareUsageSummary {
  chargeDate: string;
  productFamily: string;
  metricId: string;
  consumedUnit: string;
  consumedQuantity: number;
  billedCost: number | null;
  effectiveCost: number | null;
  currency: string;
  recordCount: number;
}

export function usageDateRange(now: Date): { from: string; to: string } {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const yesterday = new Date(today.getTime() - 86_400_000);
  return {
    from: yesterday.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  };
}

export function summarizeCloudflareUsage(
  records: CloudflareUsageRecord[],
): CloudflareUsageSummary[] {
  const summaries = new Map<
    string,
    CloudflareUsageSummary & { hasBilledCost: boolean; hasEffectiveCost: boolean }
  >();
  for (const record of records) {
    const chargeDate = record.ChargePeriodStart?.slice(0, 10) || "unknown";
    const productFamily = record.x_ProductFamilyName || "unknown";
    const metricId = record.x_BillableMetricId || "unknown";
    const consumedUnit = record.ConsumedUnit || "unknown";
    const currency = record.BillingCurrency || "USD";
    const key = [chargeDate, productFamily, metricId, consumedUnit, currency].join("\u001f");
    const current = summaries.get(key) ?? {
      chargeDate,
      productFamily,
      metricId,
      consumedUnit,
      consumedQuantity: 0,
      billedCost: 0,
      effectiveCost: 0,
      currency,
      recordCount: 0,
      hasBilledCost: false,
      hasEffectiveCost: false,
    };
    current.consumedQuantity += finiteNumber(record.ConsumedQuantity);
    if (typeof record.BilledCost === "number" && Number.isFinite(record.BilledCost)) {
      current.billedCost = (current.billedCost ?? 0) + record.BilledCost;
      current.hasBilledCost = true;
    }
    if (
      typeof record.EffectiveCost === "number" &&
      Number.isFinite(record.EffectiveCost)
    ) {
      current.effectiveCost = (current.effectiveCost ?? 0) + record.EffectiveCost;
      current.hasEffectiveCost = true;
    }
    current.recordCount += 1;
    summaries.set(key, current);
  }

  return [...summaries.values()]
    .sort((left, right) =>
      [left.chargeDate, left.productFamily, left.metricId, left.consumedUnit]
        .join("\u001f")
        .localeCompare(
          [right.chargeDate, right.productFamily, right.metricId, right.consumedUnit].join(
            "\u001f",
          ),
        ),
    )
    .map(({ hasBilledCost, hasEffectiveCost, ...summary }) => ({
      ...summary,
      consumedQuantity: rounded(summary.consumedQuantity),
      billedCost: hasBilledCost ? rounded(summary.billedCost ?? 0) : null,
      effectiveCost: hasEffectiveCost ? rounded(summary.effectiveCost ?? 0) : null,
    }));
}

export async function syncCloudflareUsage(
  env: Env,
  now = new Date(),
): Promise<{ skipped: boolean; rows: number }> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_BILLING_API_TOKEN) {
    return { skipped: true, rows: 0 };
  }
  const range = usageDateRange(now);
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/billable/usage`,
  );
  url.searchParams.set("from", range.from);
  url.searchParams.set("to", range.to);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${env.CLOUDFLARE_BILLING_API_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`Cloudflare Billable Usage returned ${response.status}`);
  }
  const payload = await response.json<{
    success: boolean;
    result?: CloudflareUsageRecord[];
    errors?: Array<{ code?: number; message: string }>;
  }>();
  if (!payload.success) {
    throw new Error(
      payload.errors?.map((error) => error.message).join("; ") ||
        "Cloudflare Billable Usage failed",
    );
  }
  const summaries = summarizeCloudflareUsage(payload.result ?? []);
  if (summaries.length) {
    await env.DB.batch(
      summaries.map((summary) =>
        env.DB.prepare(
          `INSERT INTO cloudflare_usage_daily(
             charge_date, product_family, metric_id, consumed_unit,
             consumed_quantity, billed_cost, effective_cost, currency,
             record_count, fetched_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
           ON CONFLICT(charge_date, product_family, metric_id, consumed_unit, currency)
           DO UPDATE SET
             consumed_quantity = excluded.consumed_quantity,
             billed_cost = excluded.billed_cost,
             effective_cost = excluded.effective_cost,
             record_count = excluded.record_count,
             fetched_at = unixepoch()`,
        ).bind(
          summary.chargeDate,
          summary.productFamily,
          summary.metricId,
          summary.consumedUnit,
          summary.consumedQuantity,
          summary.billedCost,
          summary.effectiveCost,
          summary.currency,
          summary.recordCount,
        ),
      ),
    );
  }
  return { skipped: false, rows: summaries.length };
}

function finiteNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rounded(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
