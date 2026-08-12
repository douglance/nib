export interface TenantReviewPageRoute {
  kind: "page";
  tenantId: string;
  requestId: string;
  apiPrefix: string;
}

export interface TenantReviewApiRoute {
  kind: "api";
  tenantId: string;
  apiPath: string;
  apiPrefix: string;
}

export interface TenantReviewAttachmentRoute {
  kind: "attachment";
  tenantId: string;
  attachmentId: string;
}

export type TenantReviewRoute =
  | TenantReviewPageRoute
  | TenantReviewApiRoute
  | TenantReviewAttachmentRoute;

export function tenantScopedReviewLink(tenantId: string, link: string): string {
  if (!link.startsWith("/r/")) return link;
  return `/t/${encodeURIComponent(tenantId)}${link}`;
}

export function tenantReviewRoute(pathname: string): TenantReviewRoute | undefined {
  const match = pathname.match(/^\/t\/([^/]+)(\/.*)$/);
  if (!match) return undefined;
  let tenantId: string;
  try {
    tenantId = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  const suffix = match[2];
  const apiPrefix = `/t/${encodeURIComponent(tenantId)}/v1`;
  const page = suffix.match(/^\/r\/([^/]+)$/);
  if (page) {
    try {
      return { kind: "page", tenantId, requestId: decodeURIComponent(page[1]), apiPrefix };
    } catch {
      return undefined;
    }
  }
  if (suffix === "/v1" || suffix.startsWith("/v1/")) {
    return { kind: "api", tenantId, apiPath: suffix, apiPrefix };
  }
  const attachment = suffix.match(/^\/attachments\/([0-9a-f-]{36})$/i);
  if (attachment) {
    return { kind: "attachment", tenantId, attachmentId: attachment[1]! };
  }
  return undefined;
}

export async function tenantScopedReviewResponse(
  response: Response,
  tenantId: string,
): Promise<Response> {
  if (!(response.headers.get("content-type") || "").includes("application/json")) return response;
  const body = await response.json() as Record<string, unknown>;
  if (typeof body.reviewLink !== "string" || !body.reviewLink.startsWith("/r/")) {
    return jsonResponse(body, response);
  }
  return jsonResponse(
    { ...body, reviewLink: tenantScopedReviewLink(tenantId, body.reviewLink) },
    response,
  );
}

export function tenantScopedReviewApiResponse(
  response: Response,
  apiPrefix: string,
  secure: boolean,
): Response {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  let scoped = cookie.replace("Path=/v1/", `Path=${apiPrefix}/`);
  if (!secure) scoped = scoped.replace("; Secure", "");
  headers.set("set-cookie", scoped);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(body: Record<string, unknown>, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
