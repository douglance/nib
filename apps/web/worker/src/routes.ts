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
