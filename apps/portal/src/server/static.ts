import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf"
};

interface ServeFileOptions {
  request?: http.IncomingMessage;
  contentType?: string;
}

export function serveFile(res: http.ServerResponse, filePath: string, options: ServeFileOptions = {}): void {
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    const contentType = options.contentType ?? contentTypes[path.extname(filePath)] ?? "application/octet-stream";
    const range = options.request?.headers.range;
    const parsedRange = range ? byteRange(range, stat.size) : null;
    if (range && !parsedRange) {
      res.writeHead(416, {
        "content-range": `bytes */${stat.size}`,
        "accept-ranges": "bytes",
        "cache-control": "no-cache"
      });
      res.end();
      return;
    }
    const start = parsedRange?.start ?? 0;
    const end = parsedRange?.end ?? Math.max(0, stat.size - 1);
    res.writeHead(parsedRange ? 206 : 200, {
      "content-type": contentType,
      "content-length": Math.max(0, end - start + 1),
      "accept-ranges": "bytes",
      ...(parsedRange ? { "content-range": `bytes ${start}-${end}/${stat.size}` } : {}),
      "cache-control": "no-cache"
    });
    if (options.request?.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

function byteRange(value: string, size: number): { start: number; end: number } | null {
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size <= 0) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}
