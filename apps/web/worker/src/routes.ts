export function isPublicPage(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/docs" ||
    pathname === "/pricing" ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname.startsWith("/assets/")
  );
}

export function isPublicAuthPage(pathname: string): boolean {
  return pathname === "/signin" || pathname === "/device";
}

export function isHostedNibRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/api/requests") ||
    pathname.startsWith("/api/projects") ||
    pathname.startsWith("/api/activity") ||
    pathname.startsWith("/api/waiting") ||
    pathname.startsWith("/api/devices") ||
    pathname.startsWith("/api/notifications") ||
    pathname.startsWith("/api/feedback") ||
    pathname.startsWith("/v1/") ||
    pathname.startsWith("/attachments/")
  );
}

export function publicReviewTenantId(pathname: string): string | undefined {
  const match = /^\/t\/([^/]+)(?:\/r\/[^/]+|\/v1(?:\/.*)?|\/attachments\/[0-9a-f-]{36})$/i.exec(pathname);
  if (!match) return undefined;
  try {
    const tenantId = decodeURIComponent(match[1]!);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tenantId)
      ? tenantId
      : undefined;
  } catch {
    return undefined;
  }
}

export function withoutTrustedGuestContext(request: Request): Request {
  const headers = new Headers(request.headers);
  const reviewSession = headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith("nib_review_session="));

  if (reviewSession) headers.set("cookie", reviewSession);
  else headers.delete("cookie");
  headers.delete("cf-access-jwt-assertion");
  headers.delete("authorization");
  headers.delete("x-nib-tenant");
  headers.delete("x-nib-trial-network");
  return new Request(request, { headers });
}

export function isSiteAsset(pathname: string): boolean {
  return pathname.startsWith("/assets/");
}

export function isPrivatePage(pathname: string): boolean {
  return pathname === "/account";
}

export function isPublicDiscovery(pathname: string): boolean {
  return (
    pathname === "/openapi.json" || pathname.startsWith("/.well-known/skills/")
  );
}

const PUBLIC_MCP_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
]);

export async function isPublicMcpDiscoveryRequest(
  request: Request,
): Promise<boolean> {
  if (request.method === "GET" || request.method === "OPTIONS") return true;
  if (request.method !== "POST") return false;

  try {
    const payload: unknown = await request.clone().json();
    const messages = Array.isArray(payload) ? payload : [payload];
    return (
      messages.length > 0 &&
      messages.every(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          typeof message.method === "string" &&
          PUBLIC_MCP_METHODS.has(message.method),
      )
    );
  } catch {
    return false;
  }
}
