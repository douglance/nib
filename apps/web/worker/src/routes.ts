export function isPublicPage(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/docs" ||
    pathname === "/pricing" ||
    pathname === "/support" ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname.startsWith("/assets/")
  );
}

export function isSiteAsset(pathname: string): boolean {
  return pathname.startsWith("/assets/");
}

export function isPrivatePage(pathname: string): boolean {
  return pathname === "/account" || pathname === "/account/delete";
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
