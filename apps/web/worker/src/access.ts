import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./types";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifiedTenant(request: Request, env: Env): Promise<string | undefined> {
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
