import { handleAccountAuth, verifiedAccount } from "./account-auth";
import { deleteAccount, purgeDeletedAccountArtifacts } from "./account-deletion";
import {
  artifactResponse,
  GenerationWorkflow,
  handleGeneration,
  runMaintenance,
} from "./generation";
import {
  billingStatus,
  changePlan,
  consumeMetering,
  createCheckout,
  createPortal,
  handleStripeWebhook,
} from "./billing";
import { TenantGate } from "./tenant-gate";
import { GenerationScheduler } from "./scheduler";
import { TrialGate } from "./trial";
import { trialNetworkHash } from "./trial-policy";
import {
  isPrivatePage,
  isPublicDiscovery,
  isPublicMcpDiscoveryRequest,
  isPublicPage,
  isPublicReviewCapabilityRoute,
  isSiteAsset,
  legacyReviewInterfaceRedirect,
} from "./routes";
import { searchDiscoveryResponse } from "./search-discovery";
import { agentApiResponse } from "./agent-api";
import { mcpResponse } from "./mcp";
import { syncCloudflareUsage } from "./cloudflare-usage";
import type { Env as Bindings, MeterEvent } from "./types";
import { handleAcceptanceRequest } from "./acceptance/api";
import { AcceptanceCoordinator } from "./acceptance/coordinator";
import type { AcceptanceEvent } from "./acceptance/contracts";
import { consumeAcceptanceEvents } from "./acceptance/delivery";
import { deliverQueuedCustomerWebhooks } from "./acceptance/integrations";
import { reconcileGitHubAcceptanceChecks } from "./acceptance/github";
import { sendPendingInvitationEmails } from "./acceptance/teams";

export {
  AcceptanceCoordinator,
  GenerationScheduler,
  GenerationWorkflow,
  TenantGate,
  TrialGate,
};

export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return Response.json({ ok: true, service: "nib" });
    if (url.pathname === "/billing/webhook" && request.method === "POST")
      return handleStripeWebhook(request, env);
    const authResponse = await handleAccountAuth(request, env);
    if (authResponse) return authResponse;
    const acceptanceResponse = await handleAcceptanceRequest(request, env);
    if (acceptanceResponse) return acceptanceResponse;
    if (
      url.pathname === "/.well-known/apple-app-site-association" &&
      request.method === "GET"
    ) {
      return appleAppSiteAssociation();
    }
    if (isPublicReviewCapabilityRoute(url.pathname))
      return env.REVIEW.fetch(withoutTrustedContext(request));
    if (url.pathname.startsWith("/r/") && request.method === "GET") {
      const account = await verifiedAccount(request, env);
      if (!account) {
        const signIn = new URL("/auth/sign-in", url);
        signIn.searchParams.set("returnTo", url.pathname);
        return Response.redirect(signIn, 302);
      }
      return legacyReviewInterfaceRedirect(url, account.id);
    }
    if (request.method === "GET") {
      const discovery = searchDiscoveryResponse(
        url.pathname,
        env.PUBLIC_ORIGIN,
      );
      if (discovery) return discovery;
      const api = agentApiResponse(url.pathname, env.PUBLIC_ORIGIN);
      if (api) return api;
    }
    if (request.method === "GET" && isPublicPage(url.pathname))
      return siteResponse(request, env, true);
    if (request.method === "GET" && isPublicDiscovery(url.pathname))
      return new Response("Not found", { status: 404 });

    if (url.pathname === "/mcp") {
      const account = await verifiedAccount(request, env);
      if (!account) {
        if (!(await isPublicMcpDiscoveryRequest(request)))
          return new Response("Unauthorized", { status: 401 });
        return mcpResponse(withoutTrustedContext(request), env, ctx);
      }
      const routed = await withTrustedTenant(request, account.id, env);
      return mcpResponse(routed, env, ctx);
    }

    const account = await verifiedAccount(request, env);
    if (!account) return new Response("Unauthorized", { status: 401 });
    const accountId = account.id;
    if (
      (url.pathname === "/api/account" && request.method === "DELETE") ||
      (url.pathname === "/api/account/delete" && request.method === "POST")
    )
      return deleteAccount(request, account, env);
    if (isReviewRoute(url.pathname))
      return env.REVIEW.fetch(withReviewAccount(request, accountId));
    if (request.method === "GET" && isPrivatePage(url.pathname))
      return siteResponse(request, env, false);
    if (url.pathname === "/billing/checkout" && request.method === "POST")
      return createCheckout(request, accountId, env);
    if (url.pathname === "/billing/portal" && request.method === "POST")
      return createPortal(accountId, env, request);
    if (url.pathname === "/billing/plan" && request.method === "POST")
      return changePlan(request, accountId, env);
    if (url.pathname === "/billing/status" && request.method === "GET")
      return billingStatus(accountId, env);
    if (url.pathname.startsWith("/artifacts/") && request.method === "GET") {
      return artifactResponse(
        request,
        accountId,
        url.pathname.slice("/artifacts/".length),
        env,
      );
    }

    const routed = await withTrustedTenant(request, accountId, env);
    if (url.pathname === "/internal/v1/generate" && request.method === "POST") {
      return handleGeneration(routed, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatch<MeterEvent | AcceptanceEvent>, env: Bindings): Promise<void> {
    if (batch.messages.some(message => "type" in message.body && message.body.type === "acceptance.changed")) {
      await consumeAcceptanceEvents(batch as MessageBatch<AcceptanceEvent>, env);
    } else await consumeMetering(batch as MessageBatch<MeterEvent>, env);
  },

  async scheduled(_event: ScheduledController, env: Bindings): Promise<void> {
    if (_event.cron === "* * * * *") {
      await Promise.all([
        deliverQueuedCustomerWebhooks(env), reconcileGitHubAcceptanceChecks(env),
        ...(env.ACCEPTANCE_ENABLED === "true" ? [sendPendingInvitationEmails(env)] : []),
      ]);
      return;
    }
    await runMaintenance(env);
    await purgeDeletedAccountArtifacts(env);
    try {
      await syncCloudflareUsage(env);
    } catch (error) {
      console.error("Cloudflare Billable Usage sync failed", error);
    }
  },
} satisfies ExportedHandler<Bindings, MeterEvent | AcceptanceEvent>;

function withoutTrustedContext(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("cf-access-jwt-assertion");
  headers.delete("x-nib-tenant");
  headers.delete("x-nib-account-id");
  headers.delete("x-nib-trial-network");
  return new Request(request, { headers });
}

function withReviewAccount(request: Request, accountId: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("cf-access-jwt-assertion");
  headers.delete("x-nib-account-id");
  headers.delete("x-nib-tenant");
  headers.set("x-nib-account-id", accountId);
  return new Request(request, { headers });
}

function isReviewRoute(pathname: string): boolean {
  const prefixes = [
    "/api/requests",
    "/api/projects",
    "/api/activity",
    "/api/waiting",
    "/api/devices",
    "/api/notifications",
    "/api/nib-files",
    "/api/feedback",
    "/attachments/",
  ];
  return prefixes.some((prefix) =>
    prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function appleAppSiteAssociation(): Response {
  return Response.json({
    applinks: {
      apps: [],
      details: [
        {
          appIDs: [
            "2AS3V73632.com.douglance.nib",
            "2AS3V73632.com.douglance.nib.macos",
          ],
          components: [{ "/": "/auth/*" }, { "/": "/r/*" }],
        },
      ],
    },
  }, { headers: { "cache-control": "public, max-age=3600" } });
}

async function withTrustedTenant(
  request: Request,
  tenantId: string,
  env: Bindings,
): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete("cf-access-jwt-assertion");
  headers.delete("x-nib-tenant");
  headers.delete("x-nib-trial-network");
  headers.set("x-nib-tenant", tenantId);
  const networkHash = await trialNetworkHash(request, env.TRIAL_NETWORK_SECRET);
  if (networkHash) headers.set("x-nib-trial-network", networkHash);
  return new Request(request, { headers });
}

async function siteResponse(
  request: Request,
  env: Bindings,
  publicCache: boolean,
): Promise<Response> {
  const url = new URL(request.url);
  const response = await (isSiteAsset(url.pathname)
    ? env.ASSETS.fetch(assetRequest(request, url))
    : env.SITE.fetch(request));
  const headers = new Headers(response.headers);
  headers.set(
    "cache-control",
    publicCache
      ? "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"
      : "private, no-store",
  );
  headers.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'",
  );
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function assetRequest(request: Request, url: URL): Request {
  url.pathname = url.pathname.slice("/assets".length);
  return new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
  });
}
