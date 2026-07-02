import type { ProjectInfo } from "../shared/types";

export const PRTL_SERVER_BASE = "http://127.0.0.1:4070";

export interface NativeFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeWebView {
  label?: string;
  setFrame?: (frame: NativeFrame) => Promise<void>;
  navigate?: (url: string) => Promise<void>;
  setLayer?: (layer: number) => Promise<void>;
  close?: () => Promise<void>;
}

interface NativeWebViewsApi {
  create?: (options: {
    label: string;
    url: string;
    frame: NativeFrame;
    layer?: number;
    transparent?: boolean;
    bridge?: boolean;
  }) => Promise<NativeWebView>;
  list?: () => Promise<NativeWebView[]>;
  setFrame?: (options: NativeFrame & { label: string }) => Promise<void>;
  navigate?: (options: { label: string; url: string }) => Promise<void>;
  setLayer?: (options: { label: string; layer: number }) => Promise<void>;
  close?: (options: { label: string }) => Promise<void>;
}

interface NativeZero {
  webviews?: NativeWebViewsApi;
}

export interface NativeWebViewOptions {
  label: string;
  url: string | null;
  frame: NativeFrame;
  layer: number;
  bridge?: boolean;
  transparent?: boolean;
}

export function isNativeShell(): boolean {
  return Boolean(nativeWebViews());
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

export function serverUrl(path: string): string {
  return `${PRTL_SERVER_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export function nativeWebViews(): NativeWebViewsApi | null {
  const candidate = window as unknown as { zero?: NativeZero };
  return candidate.zero?.webviews ?? null;
}

export function measureNativeFrame(element: HTMLElement | null): NativeFrame | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (width <= 1 || height <= 1) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width,
    height
  };
}

export async function ensureNativeWebView(options: NativeWebViewOptions): Promise<NativeWebView | null> {
  const api = nativeWebViews();
  if (!api || !options.url) return null;
  const existing = await findNativeWebView(api, options.label);
  const view = existing ?? await api.create?.({
    label: options.label,
    url: options.url,
    frame: options.frame,
    layer: options.layer,
    transparent: options.transparent ?? false,
    bridge: options.bridge ?? false
  });
  if (!view) return null;
  await setNativeWebViewFrame(api, view, options.label, options.frame);
  await setNativeWebViewLayer(api, view, options.label, options.layer);
  await navigateNativeWebView(api, view, options.label, options.url);
  return view;
}

export async function closeNativeWebView(label: string): Promise<void> {
  const api = nativeWebViews();
  if (!api) return;
  const view = await findNativeWebView(api, label);
  if (view?.close) {
    await view.close();
    return;
  }
  await api.close?.({ label });
}

export function nativeTargetUrl(project: ProjectInfo, appPath: string): string {
  if (project.targetKind === "website" && project.url) return appendAppPath(project.url, appPath);
  if (project.targetKind === "html-artifact") return appendAppPath(serverUrl(`/artifacts/${project.id}/`), appPath);
  if (project.targetKind === "builtin") return appendAppPath(serverUrl("/lab/feedback/"), appPath);
  if (project.targetKind === "local-app" && project.port) {
    const host = normalizeLocalHost(project.host);
    return appendAppPath(`http://${host}:${project.port}/`, appPath);
  }
  return appendAppPath(serverUrl(project.openPath), appPath);
}

export function nativeFeedbackSurfaceUrl(requestId: string): string {
  return serverUrl(`/feedback-surfaces/${encodeURIComponent(requestId)}/`);
}

function appendAppPath(routeUrl: string, appPath: string): string {
  const normalized = appPath.trim() || "/";
  if (normalized === "/") return routeUrl;
  const [pathAndQuery, hash = ""] = normalized.split("#", 2);
  const [pathname, search = ""] = pathAndQuery.split("?", 2);
  const suffix = `${pathname.replace(/^\/+/, "")}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
  return routeUrl.endsWith("/") ? `${routeUrl}${suffix}` : `${routeUrl}/${suffix}`;
}

async function findNativeWebView(api: NativeWebViewsApi, label: string): Promise<NativeWebView | null> {
  const views = await api.list?.().catch(() => []);
  return views?.find((view) => view.label === label) ?? null;
}

async function setNativeWebViewFrame(
  api: NativeWebViewsApi,
  view: NativeWebView,
  label: string,
  frame: NativeFrame
): Promise<void> {
  if (view.setFrame) {
    await view.setFrame(frame);
    return;
  }
  await api.setFrame?.({ label, ...frame });
}

async function navigateNativeWebView(
  api: NativeWebViewsApi,
  view: NativeWebView,
  label: string,
  url: string
): Promise<void> {
  if (view.navigate) {
    await view.navigate(url);
    return;
  }
  await api.navigate?.({ label, url });
}

async function setNativeWebViewLayer(
  api: NativeWebViewsApi,
  view: NativeWebView,
  label: string,
  layer: number
): Promise<void> {
  if (view.setLayer) {
    await view.setLayer(layer);
    return;
  }
  await api.setLayer?.({ label, layer });
}

function normalizeLocalHost(host: string): string {
  if (!host || host === "0.0.0.0" || host === "*" || host === "::") return "127.0.0.1";
  if (host === "::1") return "[::1]";
  return host;
}
