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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPublicReviewCapabilityRoute(pathname: string): boolean {
  try {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return parts[0] === "r" && UUID.test(parts[1] || "") && UUID.test(parts[2] || "");
  } catch {
    return false;
  }
}

export function legacyReviewInterfaceRedirect(url: URL, accountId: string): Response {
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 2 || parts[0] !== "r" || !UUID.test(parts[1] || "") || !UUID.test(accountId)) {
      return new Response("Not found", { status: 404 });
    }
    const destination = new URL(
      `/r/${encodeURIComponent(accountId.toLowerCase())}/${encodeURIComponent(parts[1]!.toLowerCase())}`,
      url,
    );
    return Response.redirect(destination, 302);
  } catch {
    return new Response("Not found", { status: 404 });
  }
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
