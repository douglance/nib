import { describe, expect, it } from "vitest";
import {
  summarizeCloudflareUsage,
  usageDateRange,
} from "./cloudflare-usage";

describe("Cloudflare Billable Usage telemetry", () => {
  it("summarizes account records by day, product, metric, and unit", () => {
    expect(
      summarizeCloudflareUsage([
        {
          ChargePeriodStart: "2026-08-02T00:00:00Z",
          ConsumedQuantity: 10,
          ConsumedUnit: "Requests",
          BilledCost: 0.1,
          EffectiveCost: 0.08,
          BillingCurrency: "USD",
          x_BillableMetricId: "workers_requests",
          x_ProductFamilyName: "Workers",
        },
        {
          ChargePeriodStart: "2026-08-02T00:00:00Z",
          ConsumedQuantity: 5,
          ConsumedUnit: "Requests",
          BilledCost: 0.05,
          EffectiveCost: 0.04,
          BillingCurrency: "USD",
          x_BillableMetricId: "workers_requests",
          x_ProductFamilyName: "Workers",
        },
        {
          ChargePeriodStart: "2026-08-02T00:00:00Z",
          ConsumedQuantity: 2,
          ConsumedUnit: "Images",
          BillingCurrency: "USD",
          x_BillableMetricId: "ai_images",
          x_ProductFamilyName: "AI Gateway",
        },
      ]),
    ).toEqual([
      {
        chargeDate: "2026-08-02",
        productFamily: "AI Gateway",
        metricId: "ai_images",
        consumedUnit: "Images",
        consumedQuantity: 2,
        billedCost: null,
        effectiveCost: null,
        currency: "USD",
        recordCount: 1,
      },
      {
        chargeDate: "2026-08-02",
        productFamily: "Workers",
        metricId: "workers_requests",
        consumedUnit: "Requests",
        consumedQuantity: 15,
        billedCost: 0.15,
        effectiveCost: 0.12,
        currency: "USD",
        recordCount: 2,
      },
    ]);
  });

  it("queries the previous complete UTC day", () => {
    expect(usageDateRange(new Date("2026-08-03T17:00:00Z"))).toEqual({
      from: "2026-08-02",
      to: "2026-08-03",
    });
  });
});
