import { verifiedTenant } from "./access";
import { createAuth } from "./auth";
import { authPageResponse } from "./app-ui";
import { isTrustedAccountMutation, verifiedPrincipal, verifiedSessionPrincipal } from "./access";
import {
  artifactResponse,
  GenerationWorkflow,
  handleGeneration,
  runMaintenance,
} from "./generation";
import {
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
  isHostedNibRoute,
  isPublicAuthPage,
  isPublicDiscovery,
  isPublicMcpDiscoveryRequest,
  isPublicPage,
  isSiteAsset,
  publicReviewTenantId,
  withoutTrustedGuestContext,
} from "./routes";
import { searchDiscoveryResponse } from "./search-discovery";
import { agentApiResponse } from "./agent-api";
import { mcpResponse } from "./mcp";
import { syncCloudflareUsage } from "./cloudflare-usage";
import { e2eSupportResponse } from "./e2e-support";
import {
  expertTokenScopes,
  hasRequiredExpertScope,
  issueExpertToken,
  listExpertTokens,
  requiredExpertScope,
  revokeExpertToken,
} from "./expert-token";
import type { Env as Bindings, MeterEvent } from "./types";

export {
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
    return withSecurityHeaders(await (async () => {
    const url = new URL(request.url);
    const e2eResponse = await e2eSupportResponse(request, env);
    if (e2eResponse) return e2eResponse;
    if (url.pathname === "/health")
      return Response.json({ ok: true, service: "nib" });
    if (url.pathname === "/billing/webhook" && request.method === "POST")
      return handleStripeWebhook(request, env);
    if (url.pathname.startsWith("/api/auth/"))
      return createAuth(env).handler(request);
    if (request.method === "GET" && url.pathname === "/device") {
      if (!(await verifiedPrincipal(request, env))) {
        const signIn = new URL("/signin", url.origin);
        signIn.searchParams.set("callbackURL", `${url.pathname}${url.search}`);
        return Response.redirect(signIn, 302);
      }
    }
    if (request.method === "GET" && isPublicAuthPage(url.pathname))
      return authPageResponse(url.pathname, env.TURNSTILE_SITE_KEY) ?? new Response("Not found", { status: 404 });
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

    const guestReviewTenantId = publicReviewTenantId(url.pathname);
    if (guestReviewTenantId) {
      return env.NIB_SERVICE.fetchForTenant(
        withoutTrustedGuestContext(request),
        guestReviewTenantId,
        "guest-review",
      );
    }

    if (url.pathname === "/mcp") {
      const principal = await verifiedPrincipal(request, env);
      const tenantId = principal?.workspaceId ?? await verifiedTenant(request, env);
      if (!tenantId) {
        if (!(await isPublicMcpDiscoveryRequest(request)))
          return new Response("Unauthorized", { status: 401 });
        return mcpResponse(withoutTrustedContext(request), env, ctx);
      }
      if (
        principal &&
        "expertToken" in principal &&
        !(await isPublicMcpDiscoveryRequest(request)) &&
        !hasRequiredExpertScope(principal.expertToken.scopes, "generate:write")
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      const routed = await withTrustedTenant(request, tenantId, env);
      return mcpResponse(routed, env, ctx);
    }

    const tenantId = await verifiedTenant(request, env);
    if (!tenantId) {
      if (request.method === "GET" && isPrivatePage(url.pathname)) {
        const signIn = new URL("/signin", url.origin);
        signIn.searchParams.set("callbackURL", `${url.pathname}${url.search}`);
        return Response.redirect(signIn, 302);
      }
      return new Response("Unauthorized", { status: 401 });
    }
    const principal = await verifiedPrincipal(request, env);
    if (url.pathname === "/api/account/tokens") {
      const sessionPrincipal = await verifiedSessionPrincipal(request, env);
      if (!sessionPrincipal) return new Response("Unauthorized", { status: 401 });
      if (request.method === "GET") {
        return Response.json({ tokens: await listExpertTokens(env, sessionPrincipal) }, noStore());
      }
      if (request.method === "POST") {
        if (!isTrustedAccountMutation(request, env)) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          const token = await issueExpertToken(env, sessionPrincipal, await request.json());
          return Response.json(token, { status: 201, ...noStore() });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Invalid token request" },
            { status: 400, ...noStore() },
          );
        }
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }
    const tokenMatch = /^\/api\/account\/tokens\/([0-9a-f]{32})$/.exec(url.pathname);
    if (tokenMatch) {
      const sessionPrincipal = await verifiedSessionPrincipal(request, env);
      if (!sessionPrincipal) return new Response("Unauthorized", { status: 401 });
      if (request.method !== "DELETE") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "DELETE" } });
      }
      if (!isTrustedAccountMutation(request, env)) {
        return new Response("Forbidden", { status: 403 });
      }
      const revoked = await revokeExpertToken(env, sessionPrincipal, tokenMatch[1]!);
      return revoked ? new Response(null, { status: 204 }) : new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/api/account" && request.method === "GET") {
      if (!principal) return new Response("Unauthorized", { status: 401 });
      const workspace = await env.DB.prepare("SELECT name, kind FROM workspaces WHERE id = ?")
        .bind(principal.workspaceId)
        .first<{ name: string; kind: string }>();
      return Response.json({
        authenticated: true,
        userId: principal.userId,
        subject: principal.userId,
        email: principal.email,
        name: principal.email,
        role: principal.role,
        platform: "account",
        kind: "expertToken" in principal ? "expert-token" : "account-session",
        credentialKind: "expertToken" in principal ? "expert-token" : "account-session",
        scopes: "expertToken" in principal ? principal.expertToken.scopes : expertTokenScopes,
        workspace: { id: principal.workspaceId, name: workspace?.name ?? "My Nib", kind: workspace?.kind ?? "personal" },
      });
    }
    if (request.method === "GET" && isPrivatePage(url.pathname))
      return authPageResponse(url.pathname) ?? siteResponse(request, env, false);
    if (url.pathname.startsWith("/billing/") && principal && "expertToken" in principal) {
      return new Response("Forbidden", { status: 403 });
    }
    if (url.pathname === "/billing/checkout" && request.method === "POST")
      return createCheckout(request, tenantId, env);
    if (url.pathname === "/billing/portal" && request.method === "POST")
      return createPortal(tenantId, env);
    if (url.pathname === "/billing/plan" && request.method === "POST")
      return changePlan(request, tenantId, env);
    if (url.pathname.startsWith("/artifacts/") && request.method === "GET") {
      if (
        principal &&
        "expertToken" in principal &&
        !hasRequiredExpertScope(principal.expertToken.scopes, requiredExpertScope(request))
      ) return new Response("Forbidden", { status: 403 });
      return artifactResponse(
        request,
        tenantId,
        url.pathname.slice("/artifacts/".length),
        env,
      );
    }

    if (principal && isHostedNibRoute(url.pathname)) {
      if (
        "expertToken" in principal &&
        !hasRequiredExpertScope(principal.expertToken.scopes, requiredExpertScope(request))
      ) return new Response("Forbidden", { status: 403 });
      return env.NIB_SERVICE.fetchForTenant(
        withoutTrustedContext(request),
        principal.workspaceId,
        principal.userId,
      );
    }
    const routed = await withTrustedTenant(request, tenantId, env);
    if (url.pathname === "/internal/v1/generate" && request.method === "POST") {
      return handleGeneration(routed, env);
    }
    return new Response("Not found", { status: 404 });
    })(), request);
  },

  async queue(batch: MessageBatch<MeterEvent>, env: Bindings): Promise<void> {
    await consumeMetering(batch, env);
  },

  async scheduled(_event: ScheduledController, env: Bindings): Promise<void> {
    await runMaintenance(env);
    try {
      await syncCloudflareUsage(env);
    } catch (error) {
      console.error("Cloudflare Billable Usage sync failed", error);
    }
  },
} satisfies ExportedHandler<Bindings, MeterEvent>;

function withoutTrustedContext(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("cf-access-jwt-assertion");
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("x-nib-tenant");
  headers.delete("x-nib-trial-network");
  return new Request(request, { headers });
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
      "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action 'self'; frame-ancestors 'none'",
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

function noStore(): ResponseInit {
  return { headers: { "cache-control": "private, no-store" } };
}

function withSecurityHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  if (new URL(request.url).protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  if ((headers.get("content-type") ?? "").includes("text/html") && !headers.has("content-security-policy")) {
    headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'",
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
