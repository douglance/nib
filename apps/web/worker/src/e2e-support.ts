import { canonicalEmail } from "./account";
import type { Env } from "./types";

const route = "/__e2e__/magic-link";

function enabled(env: Env): boolean {
  return env.ENVIRONMENT === "e2e" && Boolean(env.E2E_MAGIC_LINKS && env.E2E_TEST_SECRET);
}

function keyFor(email: string): string {
  return `magic-link:${canonicalEmail(email)}`;
}

export async function captureE2eMagicLink(
  env: Env,
  email: string,
  url: string,
): Promise<boolean> {
  if (!enabled(env)) return false;
  await env.E2E_MAGIC_LINKS!.put(keyFor(email), url, { expirationTtl: 600 });
  return true;
}

export async function e2eSupportResponse(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== route) return undefined;
  if (!enabled(env)) return new Response("Not found", { status: 404 });
  if (request.headers.get("x-nib-e2e-secret") !== env.E2E_TEST_SECRET)
    return new Response("Not found", { status: 404 });

  const email = url.searchParams.get("email");
  if (!email) return new Response("Missing email", { status: 400 });
  const magicLink = await env.E2E_MAGIC_LINKS!.get(keyFor(email));
  if (!magicLink) return new Response("Not found", { status: 404 });
  return Response.json(
    { url: magicLink },
    { headers: { "cache-control": "no-store" } },
  );
}
