import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { principalForAuthUser, provisionPersonalWorkspace, type NibPrincipal } from "./account";
import { createAuth } from "./auth";
import { authenticateExpertToken, type ExpertTokenPrincipal } from "./expert-token";
import type { Env } from "./types";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifiedTenant(request: Request, env: Env): Promise<string | undefined> {
  const principal = await verifiedPrincipal(request, env);
  if (principal) return principal.workspaceId;

  return verifiedAccessTenant(request, env);
}

export async function verifiedPrincipal(
  request: Request,
  env: Env,
): Promise<NibPrincipal | ExpertTokenPrincipal | undefined> {
  const expert = await authenticateExpertToken(request, env);
  if (expert) return expert;
  return verifiedSessionPrincipal(request, env);
}

export async function verifiedSessionPrincipal(
  request: Request,
  env: Env,
): Promise<NibPrincipal | undefined> {
  try {
    const session = await createAuth(env).api.getSession({ headers: request.headers });
    if (!session?.user) return undefined;
    return (
      (await principalForAuthUser(env, session.user.id)) ??
      (await provisionPersonalWorkspace(env, session.user))
    );
  } catch {
    return undefined;
  }
}

export function isTrustedAccountMutation(request: Request, env: Pick<Env, "PUBLIC_ORIGIN">): boolean {
  if (request.headers.has("authorization")) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(request.url).origin, env.PUBLIC_ORIGIN.replace(/\/$/, "")]);
  return allowed.has(origin.replace(/\/$/, ""));
}

async function verifiedAccessTenant(request: Request, env: Env): Promise<string | undefined> {
  if (env.ENVIRONMENT === "development") {
    const developmentTenant = request.headers.get("x-nib-dev-tenant")?.trim().toLowerCase();
    if (developmentTenant) return developmentTenant;
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_POLICY_AUD) return undefined;
  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  let keySet = keySets.get(teamDomain);
  if (!keySet) {
    // Cloudflare's Worker guidance requires validating the Access assertion
    // against the team JWKS, issuer, and application audience.
    // https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
    keySet = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keySet);
  }

  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: teamDomain,
      audience: env.ACCESS_POLICY_AUD,
    });
    return tenantFromAccessPayload(payload);
  } catch {
    return undefined;
  }
}

export function tenantFromAccessPayload(payload: JWTPayload): string | undefined {
  if (typeof payload.email === "string" && payload.email.trim()) return payload.email.trim().toLowerCase();
  if (typeof payload.common_name === "string" && payload.common_name.trim()) {
    return `service-token:${payload.common_name.trim().toLowerCase()}`;
  }
  return undefined;
}
