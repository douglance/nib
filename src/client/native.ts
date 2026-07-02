export const PRTL_SERVER_BASE = "http://127.0.0.1:4070";

interface NativeZero {
  webviews?: unknown;
}

export function isNativeShell(): boolean {
  const candidate = window as unknown as { zero?: NativeZero };
  return Boolean(candidate.zero?.webviews);
}

export function apiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return isNativeShell() ? `${PRTL_SERVER_BASE}${path}` : path;
}

export function assetUrl(pathOrUrl: string | null): string | null {
  if (!pathOrUrl) return null;
  return apiUrl(pathOrUrl);
}

export function prtlFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(input), init);
}
