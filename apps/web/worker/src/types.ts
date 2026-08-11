export type Plan = "default" | "high";
export type Quality = "fast" | "standard" | "pro";
export type Resolution = "1K" | "2K" | "4K";
export type ImageFormat = "png" | "jpg";
export type BillingMode = "paid" | "trial";

export interface ReferenceImage {
  name: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}

export interface GenerationRequest {
  prompt?: string;
  resume_job_id?: string;
  references: ReferenceImage[];
  quality: Quality;
  aspect: string;
  resolution: Resolution;
  format: ImageFormat;
  background: boolean;
}

export interface StoredGenerationRequest extends Omit<GenerationRequest, "references"> {
  tenantId: string;
  jobId: string;
  referenceKeys: string[];
  usageCents: number;
  model: string;
  plan: Plan;
  billingMode: BillingMode;
}

export interface MeterEvent {
  identifier: string;
  tenantId: string;
  stripeCustomerId: string;
  value: number;
}

export interface Env {
  CF_VERSION_METADATA: WorkerVersionMetadata;
  AI: Ai;
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  METERING_QUEUE: Queue<MeterEvent>;
  GENERATE_WORKFLOW: Workflow<StoredGenerationRequest>;
  ASSETS: Fetcher;
  SITE: Fetcher;
  NIB_SERVICE: {
    fetchForTenant(request: Request, workspaceId: string, subject: string): Promise<Response>;
  };
  EMAIL?: SendEmail;
  E2E_MAGIC_LINKS?: KVNamespace;
  E2E_TEST_SECRET?: string;
  TENANT_GATE: DurableObjectNamespace;
  SCHEDULER: DurableObjectNamespace;
  TRIAL_GATE: DurableObjectNamespace;
  AI_GATEWAY_ID: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_POLICY_AUD: string;
  ENVIRONMENT: string;
  PUBLIC_ORIGIN: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  BILLING_PORTAL_CONFIGURATION_ID: string;
  DEFAULT_PRICE_ID: string;
  HIGH_PRICE_ID: string;
  USAGE_PRICE_ID: string;
  TRIAL_NETWORK_IDENTITIES_30D: string;
  TRIAL_GLOBAL_DAILY_LIMIT: string;
  TRIAL_NETWORK_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BILLING_API_TOKEN?: string;
}
