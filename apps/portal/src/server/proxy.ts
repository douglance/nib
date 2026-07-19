import http from "node:http";
import net from "node:net";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { promisify } from "node:util";
import { CLIENT_PORT } from "./config";
import { discoverProjects, getCachedProject } from "./discovery";

const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

export async function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const match = req.url?.match(/^\/p\/([^/]+)(\/.*)?$/);
  if (!match) {
    res.writeHead(404).end("Not found");
    return;
  }

  const projectId = decodeURIComponent(match[1]);
  const project = getCachedProject(projectId) ?? (await discoverProjects(true)).find((item) => item.id === projectId);
  if (!project) {
    res.writeHead(404).end("Project not found");
    return;
  }

  const upstreamPath = `${match[2] ?? "/"}${new URL(req.url ?? "/", "http://prtl.local").search}`;
  const headers = buildProxyRequestHeaders(req, project.host, project.port, upstreamPath);

  const upstream = http.request(
    {
      host: project.host === "::1" ? "::1" : project.host,
      port: project.port,
      method: req.method,
      path: upstreamPath,
      headers
    },
    (upstreamRes) => {
      const responseHeaders = rewriteHeaders(upstreamRes.headers, project.id);
      if (req.method !== "HEAD" && shouldRewriteText(upstreamRes.headers["content-type"])) {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        upstreamRes.on("end", async () => {
          try {
            const bodyBuffer = Buffer.concat(chunks);
            const text = (await decodeBody(bodyBuffer, upstreamRes.headers["content-encoding"])).toString("utf8");
            const body = rewriteText(text, project.id, upstreamRes.headers["content-type"]);
            delete responseHeaders["content-length"];
            delete responseHeaders["content-encoding"];
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders);
            res.end(body);
          } catch (error) {
            sendProxyError(res, `Proxy decode error: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        });
        return;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders);
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (error) => {
    sendProxyError(res, `Proxy error: ${error.message}`);
  });

  req.pipe(upstream);
}

export async function proxyUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer
): Promise<void> {
  const match = req.url?.match(/^\/p\/([^/]+)(\/.*)?$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const projectId = decodeURIComponent(match[1]);
  const project = getCachedProject(projectId) ?? (await discoverProjects(true)).find((item) => item.id === projectId);
  if (!project) {
    socket.destroy();
    return;
  }

  const upstreamPath = `${match[2] ?? "/"}${new URL(req.url ?? "/", "http://prtl.local").search}`;
  const upstream = net.connect(project.port, project.host === "::1" ? "::1" : project.host);

  upstream.on("connect", () => {
    const proxyHeaders = buildProxyRequestHeaders(req, project.host, project.port, upstreamPath);
    const headers = Object.entries(proxyHeaders)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}`)
      .join("\r\n");
    upstream.write(`${req.method} ${upstreamPath} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", () => socket.destroy());
}

export function proxyToVite(req: http.IncomingMessage, res: http.ServerResponse): void {
  const headers = { ...req.headers, host: `127.0.0.1:${CLIENT_PORT}` };
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: CLIENT_PORT,
      method: req.method,
      path: req.url,
      headers
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", () => {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Frontend dev server is not ready yet. Refresh in a moment.");
  });
  req.pipe(upstream);
}

function sendProxyError(res: http.ServerResponse, message: string): void {
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.end(`\n${message}`);
    return;
  }
  res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

export function proxyViteUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  const upstream = net.connect(CLIENT_PORT, "127.0.0.1");
  upstream.on("connect", () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}`)
      .join("\r\n");
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
}

function rewriteHeaders(headers: http.IncomingHttpHeaders, projectId: string): http.OutgoingHttpHeaders {
  const rewritten: http.OutgoingHttpHeaders = { ...headers };
  const location = headers.location;
  if (typeof location === "string" && location.startsWith("/")) {
    rewritten.location = `/p/${projectId}${location}`;
  }
  if (typeof location === "string" && location.match(/^https?:\/\/[^/]+\/?/)) {
    try {
      const parsed = new URL(location);
      rewritten.location = `/p/${projectId}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      rewritten.location = location;
    }
  }
  rewriteSetCookie(rewritten, projectId);
  delete rewritten["content-security-policy"];
  delete rewritten["content-security-policy-report-only"];
  delete rewritten["x-frame-options"];
  return rewritten;
}

function buildProxyRequestHeaders(
  req: http.IncomingMessage,
  upstreamHost: string,
  upstreamPort: number,
  upstreamPath: string
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  const upstreamOrigin = `http://${hostHeader(upstreamHost, upstreamPort)}`;
  const externalHost = req.headers.host;
  headers.host = hostHeader(upstreamHost, upstreamPort);
  headers["accept-encoding"] = "identity";
  headers["x-forwarded-host"] = externalHost;
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";

  if (typeof headers.origin === "string") {
    headers.origin = upstreamOrigin;
  }
  if (typeof headers.referer === "string") {
    headers.referer = `${upstreamOrigin}${upstreamPath}`;
  }

  delete headers["content-length"];
  return headers;
}

function rewriteSetCookie(headers: http.OutgoingHttpHeaders, projectId: string): void {
  const value = headers["set-cookie"];
  if (!value) return;
  const prefix = `/p/${projectId}`;
  const rewriteCookie = (cookie: string) =>
    cookie
      .replace(/;\s*Domain=[^;]+/gi, "")
      .replace(/;\s*Path=\/(?!p\/[^;]*)/gi, `; Path=${prefix}/`);
  headers["set-cookie"] = Array.isArray(value) ? value.map(rewriteCookie) : rewriteCookie(String(value));
}

async function decodeBody(body: Buffer, encoding: string | string[] | undefined): Promise<Buffer> {
  const normalized = (Array.isArray(encoding) ? encoding[0] : encoding ?? "").toLowerCase();
  if (normalized === "br") return brotliDecompressAsync(body);
  if (normalized === "gzip" || normalized === "x-gzip") return gunzipAsync(body);
  if (normalized === "deflate") return inflateAsync(body);
  return body;
}

function hostHeader(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function shouldRewriteText(contentType: string | string[] | undefined): boolean {
  const normalized = Array.isArray(contentType) ? contentType.join(",") : contentType ?? "";
  return normalized.includes("text/html") || normalized.includes("text/css");
}

function rewriteText(text: string, projectId: string, contentType: string | string[] | undefined): string {
  const normalized = Array.isArray(contentType) ? contentType.join(",") : contentType ?? "";
  if (normalized.includes("text/css")) return rewriteCss(text, projectId);
  return rewriteHtml(text, projectId);
}

function rewriteHtml(html: string, projectId: string): string {
  const prefix = `/p/${projectId}`;
  return html
    .replace(/(href|src|action)=("|')\/(?!\/|p\/|api\/|screenshots\/)/g, `$1=$2${prefix}/`)
    .replace(/(srcset)=("|')\/(?!\/|p\/|api\/|screenshots\/)/g, `$1=$2${prefix}/`)
    .replace(/(url\()("|')?\/(?!\/|p\/|api\/|screenshots\/)/g, `$1$2${prefix}/`);
}

function rewriteCss(css: string, projectId: string): string {
  const prefix = `/p/${projectId}`;
  return css.replace(/(url\()("|')?\/(?!\/|p\/|api\/|screenshots\/|data:)/g, `$1$2${prefix}/`);
}
