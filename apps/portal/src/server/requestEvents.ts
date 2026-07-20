import type http from "node:http";
import type { RequestRecord } from "../shared/types";

const clients = new Set<http.ServerResponse>();

export function streamRequestEvents(res: http.ServerResponse): void {
  res.writeHead(200, {
    "access-control-allow-origin": "*",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8"
  });
  res.write("event: ready\ndata: {}\n\n");
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export function emitRequestEvent(action: "created" | "published" | "updated" | "responded", request: RequestRecord): void {
  const payload = `event: request\ndata: ${JSON.stringify({ action, request })}\n\n`;
  for (const client of clients) client.write(payload);
}
