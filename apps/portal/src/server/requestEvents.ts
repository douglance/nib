import type http from "node:http";
import type net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { RequestRecord } from "../shared/types";

const clients = new Set<http.ServerResponse>();
const sockets = new Set<WebSocket>();
const liveSockets = new WeakSet<WebSocket>();
const socketServer = new WebSocketServer({ noServer: true });

socketServer.on("connection", (socket) => {
  sockets.add(socket);
  liveSockets.add(socket);
  socket.on("pong", () => liveSockets.add(socket));
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
  socket.send(JSON.stringify({ type: "ready" }));
});

const heartbeat = setInterval(() => {
  for (const socket of sockets) {
    if (!liveSockets.has(socket)) {
      socket.terminate();
      continue;
    }
    liveSockets.delete(socket);
    socket.ping();
  }
}, 25_000);
heartbeat.unref();

export function upgradeRequestSocket(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer
): boolean {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/api/requests/socket") return false;
  socketServer.handleUpgrade(req, socket, head, (webSocket) => {
    socketServer.emit("connection", webSocket, req);
  });
  return true;
}

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
  const event = { type: "request", action, request } as const;
  const json = JSON.stringify(event);
  const payload = `event: request\ndata: ${json}\n\n`;
  for (const client of clients) client.write(payload);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(json);
  }
}
