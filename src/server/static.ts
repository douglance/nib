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
  ".webp": "image/webp"
};

export function serveFile(res: http.ServerResponse, filePath: string): void {
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    const contentType = contentTypes[path.extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": stat.size,
      "cache-control": "no-cache"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}
