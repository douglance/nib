import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type net from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { listPacks, readBrief, readLibraryContext, readPack } from "../html/packs";
import { validateFeedbackSurface, validateHtml } from "../html/validate";
import { ATTACHMENT_DIR, ATTACHMENT_MAX_BYTES, HOST, PORT, PUBLIC_BASE_URL, SCREENSHOT_DIR } from "./config";
import { getCommandPresets, listCommandRuns, runProjectCommand, streamCommandEvents } from "./commands";
import { discoverProjects, getPortalMeta } from "./discovery";
import {
  captureFeedbackArtifacts,
  createFeedback,
  feedbackMetrics,
  getFeedback,
  listFeedback,
  markFeedbackNotificationClicked,
  patchFeedback,
  recordFeedbackEdit,
  refreshFeedbackState,
  respondFeedback,
  streamFeedbackEvents
} from "./feedback";
import { getHealth } from "./health";
import { exportHtmlArtifact, getHtmlArtifact, listHtmlArtifacts } from "./htmlArtifacts";
import { feedbackSurfaceHtmlForNative } from "./feedbackSurface";
import { listDevices, registerDevice, removeDevice } from "./devices";
import {
  getVapidPublicKey,
  notificationStatus,
  probeApnsDelivery,
  sendTestNotification,
  subscribeNotifications,
  unsubscribeNotifications
} from "./notifications";
import { killProject } from "./processes";
import { proxyHttp, proxyToVite, proxyUpgrade, proxyViteUpgrade } from "./proxy";
import {
  addRequestAttachment,
  addRequestAttachmentFile,
  attachmentFile,
  createRequest,
  getRequest,
  listRequests,
  markRequestNotificationClicked,
  patchRequest,
  publishRequest,
  RequestContractError,
  respondRequest
} from "./requests";
import { streamRequestEvents, upgradeRequestSocket } from "./requestEvents";
import { requestPageHtml } from "./requestPage";
import { runRetentionSweep } from "./retention";
import { captureScreenshots } from "./screenshots";
import { serveFile } from "./static";
import { ensureDataDirs, readStore, writeStore } from "./store";
import type { RouteMode } from "../shared/types";
import { addHtmlTarget, addUrlTarget, artifactFileForId, listTargets, removeTarget } from "./targets";
import { getWaiting } from "./waiting/watcher";
import { appendActivity, getWorkspace, listActivity, patchWorkspace } from "./workspace";

await ensureDataDirs();

const IOS_APP_ID = process.env.NIB_IOS_APP_ID ?? "2AS3V73632.com.douglance.nib";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === "/.well-known/apple-app-site-association" || url.pathname === "/apple-app-site-association") {
      sendJson(res, appleAppSiteAssociation());
      return;
    }

    if (url.pathname === "/api/projects") {
      const projects = await discoverProjects(url.searchParams.get("refresh") === "1");
      sendJson(res, { ...getPortalMeta(), projects });
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(res, await getHealth());
      return;
    }

    if (url.pathname === "/api/activity") {
      sendJson(res, await listActivity(url.searchParams.get("projectId") ?? undefined));
      return;
    }

    if (url.pathname === "/api/waiting") {
      sendJson(res, await getWaiting());
      return;
    }

    if (await handleRequestRoute(req, res, url)) return;

    if (url.pathname === "/api/notify" && req.method === "POST") {
      const body = await readJsonBody<{ title?: string; body?: string; url?: string; tag?: string; kind?: string }>(req);
      if (!body.title?.trim() || !body.body?.trim()) {
        sendJson(res, { error: "title and body are required" }, 400);
        return;
      }
      const request = await createRequest({
        kind: "notification",
        title: body.title,
        prompt: body.body,
        body: body.body,
        url: body.url,
        metadata: { tag: body.tag, kind: body.kind },
        notify: true
      });
      sendJson(res, { sent: request.notifiedAt ? 1 : 0, request });
      return;
    }

    if (url.pathname === "/api/devices") {
      if (req.method === "GET") {
        sendJson(res, { devices: await listDevices() });
        return;
      }
      if (req.method === "POST") {
        sendJson(res, await registerDevice({ ...(await readJsonBody(req)), userAgent: req.headers["user-agent"] ?? null }), 201);
        return;
      }
    }

    if (url.pathname.match(/^\/api\/devices\/[^/]+$/) && req.method === "DELETE") {
      const deviceId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      sendJson(res, await removeDevice(deviceId));
      return;
    }

    if (url.pathname.match(/^\/api\/html\/brief\/[^/]+$/)) {
      const kind = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      sendJson(res, { kind, brief: await readBrief(kind) });
      return;
    }

    if (url.pathname === "/api/html/context") {
      sendJson(res, await readLibraryContext(url.searchParams.get("libraries") ?? "tailwind,shadcn,vanilla-js"));
      return;
    }

    if (url.pathname === "/api/html/guidance") {
      sendJson(res, { skills: await listPacks("skills"), libraries: await listPacks("libraries") });
      return;
    }

    if (url.pathname === "/api/html/artifacts") {
      sendJson(res, { artifacts: await listHtmlArtifacts() });
      return;
    }

    if (url.pathname.match(/^\/api\/html\/artifacts\/[^/]+$/)) {
      const artifactId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const artifact = await getHtmlArtifact(artifactId);
      if (!artifact) sendJson(res, { error: "HTML artifact not found" }, 404);
      else sendJson(res, artifact);
      return;
    }

    if (url.pathname.match(/^\/api\/html\/artifacts\/[^/]+\/export$/) && req.method === "POST") {
      const artifactId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const body = await readJsonBody<{ outDir?: string }>(req);
      if (!body.outDir) {
        sendJson(res, { error: "outDir is required" }, 400);
        return;
      }
      sendJson(res, await exportHtmlArtifact(artifactId, body.outDir));
      return;
    }

    if (url.pathname.match(/^\/api\/html\/guidance\/(skills|libraries)\/[^/]+$/)) {
      const [, , , , type, name] = url.pathname.split("/");
      sendJson(res, { type, name: decodeURIComponent(name ?? ""), text: await readPack(type as "skills" | "libraries", decodeURIComponent(name ?? "")) });
      return;
    }

    if (url.pathname === "/api/html/validate" && req.method === "POST") {
      const body = await readJsonBody<{ file?: string }>(req);
      if (!body.file) {
        sendJson(res, { error: "file is required" }, 400);
        return;
      }
      sendJson(res, await validateHtml(body.file));
      return;
    }

    if (url.pathname === "/api/html/feedback/validate" && req.method === "POST") {
      const body = await readJsonBody<{ file?: string }>(req);
      if (!body.file) {
        sendJson(res, { error: "file is required" }, 400);
        return;
      }
      sendJson(res, await validateFeedbackSurface(body.file));
      return;
    }

    if (url.pathname === "/api/targets") {
      if (req.method === "GET") {
        sendJson(res, { targets: await listTargets() });
        return;
      }
    }

    if (url.pathname === "/api/targets/url" && req.method === "POST") {
      sendJson(res, await addUrlTarget(await readJsonBody(req)), 201);
      return;
    }

    if (url.pathname === "/api/targets/html" && req.method === "POST") {
      sendJson(res, await addHtmlTarget(await readJsonBody(req)), 201);
      return;
    }

    if (url.pathname.match(/^\/api\/targets\/[^/]+$/) && req.method === "DELETE") {
      const targetId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      sendJson(res, await removeTarget(targetId));
      return;
    }

    if (url.pathname === "/api/feedback") {
      if (req.method === "GET") {
        sendJson(
          res,
          await listFeedback(
            url.searchParams.get("projectId") ?? undefined,
            url.searchParams.get("includeMissing") === "1"
          )
        );
        return;
      }
      if (req.method === "POST") {
        sendJson(res, await createFeedback(await readJsonBody(req)), 201);
        return;
      }
    }

    if (url.pathname === "/api/feedback/metrics") {
      sendJson(res, await feedbackMetrics());
      return;
    }

    if (url.pathname.match(/^\/api\/feedback\/[^/]+$/)) {
      const feedbackId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (req.method === "GET") {
        const item = await refreshFeedbackState(feedbackId, url.searchParams.get("viewed") === "1");
        if (!item) sendJson(res, { error: "Feedback not found" }, 404);
        else sendJson(res, item);
        return;
      }
      if (req.method === "PATCH") {
        const item = await patchFeedback(feedbackId, await readJsonBody(req));
        if (!item) sendJson(res, { error: "Feedback not found" }, 404);
        else sendJson(res, item);
        return;
      }
    }

    if (url.pathname.match(/^\/api\/feedback\/[^/]+\/events$/)) {
      const feedbackId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const item = await getFeedback(feedbackId);
      if (!item) {
        sendJson(res, { error: "Feedback not found" }, 404);
        return;
      }
      streamFeedbackEvents(feedbackId, res);
      return;
    }

    if (url.pathname.match(/^\/api\/feedback\/[^/]+\/respond$/) && req.method === "POST") {
      const feedbackId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const item = await respondFeedback(feedbackId, await readJsonBody(req));
      if (!item) sendJson(res, { error: "Feedback not found" }, 404);
      else sendJson(res, item);
      return;
    }

    if (url.pathname.match(/^\/api\/feedback\/[^/]+\/edit$/) && req.method === "POST") {
      const feedbackId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const item = await recordFeedbackEdit(feedbackId, await readJsonBody(req));
      if (!item) sendJson(res, { error: "Feedback not found" }, 404);
      else sendJson(res, item);
      return;
    }

    if (url.pathname.match(/^\/api\/feedback\/[^/]+\/capture$/) && req.method === "POST") {
      const feedbackId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const item = await captureFeedbackArtifacts(feedbackId);
      if (!item) sendJson(res, { error: "Feedback not found" }, 404);
      else sendJson(res, item);
      return;
    }

    if (url.pathname.match(/^\/api\/feedback\/[^/]+\/notification-click$/) && req.method === "POST") {
      const feedbackId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const item = await markFeedbackNotificationClicked(feedbackId);
      if (!item) sendJson(res, { error: "Feedback not found" }, 404);
      else sendJson(res, item);
      return;
    }

    if (url.pathname === "/api/notifications/vapid-public-key") {
      sendJson(res, { publicKey: await getVapidPublicKey() });
      return;
    }

    if (url.pathname === "/api/notifications/status") {
      sendJson(res, await notificationStatus());
      return;
    }

    if (url.pathname === "/api/notifications/subscribe" && req.method === "POST") {
      const body = await readJsonBody<{ subscription?: PushSubscriptionJSON }>(req);
      sendJson(res, await subscribeNotifications({ ...body, userAgent: req.headers["user-agent"] ?? null }), 201);
      return;
    }

    if (url.pathname === "/api/notifications/unsubscribe" && req.method === "POST") {
      const body = await readJsonBody<{ endpoint?: string }>(req);
      if (!body.endpoint) {
        sendJson(res, { error: "endpoint is required" }, 400);
        return;
      }
      sendJson(res, await unsubscribeNotifications(body.endpoint));
      return;
    }

    if (url.pathname === "/api/notifications/test" && req.method === "POST") {
      sendJson(res, await sendTestNotification());
      return;
    }

    if (url.pathname === "/api/notifications/apns/probe" && req.method === "POST") {
      sendJson(res, await probeApnsDelivery());
      return;
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/compatibility$/)) {
      const projectId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const projects = await discoverProjects(url.searchParams.get("refresh") === "1");
      const project = projects.find((item) => item.id === projectId);
      if (!project) {
        sendJson(res, { error: "Project not found" }, 404);
        return;
      }
      sendJson(res, {
        projectId,
        routes: project.routes,
        preferredRoute: project.preferredRoute,
        compatibility: project.compatibility
      });
      return;
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/recheck$/) && req.method === "POST") {
      const projectId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const projects = await discoverProjects(true);
      const project = projects.find((item) => item.id === projectId);
      if (!project) {
        sendJson(res, { error: "Project not found" }, 404);
        return;
      }
      sendJson(res, project);
      return;
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/kill$/) && req.method === "POST") {
      const projectId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      try {
        const result = await killProject(projectId);
        await appendActivity({
          kind: "system",
          projectId,
          message: result.killed ? `Killed ${result.name}` : `Kill requested for ${result.name}`,
          data: result
        });
        sendJson(res, result);
      } catch (error) {
        sendJson(res, { error: error instanceof Error ? error.message : "Kill failed" }, 400);
      }
      return;
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/preferred-route$/) && req.method === "POST") {
      const projectId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const body = await readJsonBody<{ mode?: RouteMode }>(req);
      if (!body.mode || !["direct", "pathProxy", "hostProxy"].includes(body.mode)) {
        sendJson(res, { error: "Invalid route mode" }, 400);
        return;
      }
      const store = await readStore();
      const existing = store.projects[projectId] ?? { id: projectId, lastKey: projectId };
      store.projects[projectId] = { ...existing, preferredRoute: body.mode };
      await writeStore(store);
      const project = (await discoverProjects(true)).find((item) => item.id === projectId);
      if (!project) {
        sendJson(res, { error: "Project not found" }, 404);
        return;
      }
      sendJson(res, project);
      return;
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/screenshots$/) && req.method === "POST") {
      const projectId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      await discoverProjects(true);
      const screenshots = await captureScreenshots(projectId);
      await appendActivity({ kind: "screenshot", projectId, message: "Captured screenshots", data: screenshots });
      sendJson(res, { projectId, screenshots });
      return;
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/workspace$/)) {
      const projectId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (req.method === "GET") {
        sendJson(res, await getWorkspace(projectId));
        return;
      }
      if (req.method === "PATCH") {
        sendJson(res, await patchWorkspace(projectId, await readJsonBody(req)));
        return;
      }
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/commands$/)) {
      const projectId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (req.method === "GET") {
        sendJson(res, await listCommandRuns(projectId));
        return;
      }
      if (req.method === "POST") {
        sendJson(res, await runProjectCommand(projectId, await readJsonBody(req)), 202);
        return;
      }
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/command-presets$/)) {
      const projectId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      sendJson(res, await getCommandPresets(projectId));
      return;
    }

    if (url.pathname.match(/^\/api\/projects\/[^/]+\/commands\/[^/]+\/events$/)) {
      const commandId = decodeURIComponent(url.pathname.split("/")[5] ?? "");
      streamCommandEvents(commandId, res);
      return;
    }

    if (url.pathname.startsWith("/screenshots/")) {
      serveFile(res, path.join(SCREENSHOT_DIR, path.basename(url.pathname)));
      return;
    }

    if (url.pathname.match(/^\/attachments\/[^/]+$/)) {
      const attachmentId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      const attachment = await attachmentFile(attachmentId);
      if (!attachment) {
        sendJson(res, { error: "Attachment not found" }, 404);
        return;
      }
      serveFile(res, attachment.file, { request: req, contentType: attachment.contentType });
      return;
    }

    if (url.pathname.match(/^\/r\/[^/]+\/?$/)) {
      const requestId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      const request = await getRequest(requestId);
      if (!request) {
        res.writeHead(404, { ...corsHeaders(), "content-type": "text/plain; charset=utf-8" });
        res.end("Request not found");
        return;
      }
      if (isIOSBrowser(req) && url.searchParams.get("web") !== "1") {
        res.writeHead(302, {
          location: nativeRequestUrl(requestId),
          "cache-control": "no-store"
        });
        res.end();
        return;
      }
      if (request.kind === "visual-review") {
        if (process.env.NODE_ENV !== "production") proxyToVite(req, res);
        else serveFile(res, path.join(process.cwd(), "dist/client/index.html"));
        return;
      }
      sendHtml(res, requestPageHtml(request));
      return;
    }

    if (url.pathname === "/lab/feedback/" || url.pathname === "/lab/feedback") {
      sendHtml(res, feedbackLabHtml());
      return;
    }

    if (url.pathname.match(/^\/feedback-surfaces\/[^/]+\/?$/)) {
      const feedbackId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      const request = await getFeedback(feedbackId);
      if (!request?.feedbackSurface) {
        sendJson(res, { error: "Feedback surface not found" }, 404);
        return;
      }
      sendHtml(res, feedbackSurfaceHtmlForNative(request));
      return;
    }

    if (url.pathname.match(/^\/artifacts\/[^/]+\/?$/)) {
      const targetId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      const file = await artifactFileForId(targetId);
      if (!file) {
        sendJson(res, { error: "Artifact not found" }, 404);
        return;
      }
      serveFile(res, file);
      return;
    }

    if (url.pathname.startsWith("/p/")) {
      await proxyHttp(req, res);
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      proxyToVite(req, res);
      return;
    }

    const distPath = path.join(process.cwd(), "dist/client");
    const filePath = path.join(distPath, url.pathname === "/" ? "index.html" : url.pathname);
    if (fs.existsSync(filePath)) serveFile(res, filePath);
    else serveFile(res, path.join(distPath, "index.html"));
  } catch (error) {
    const statusCode = error instanceof RequestContractError ? error.statusCode : 500;
    res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }));
  }
});

server.on("upgrade", async (req, socket, head) => {
  if (upgradeRequestSocket(req, socket as net.Socket, head)) return;
  if (req.url?.startsWith("/p/")) {
    await proxyUpgrade(req, socket as net.Socket, head);
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    proxyViteUpgrade(req, socket as net.Socket, head);
    return;
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`nib listening at ${PUBLIC_BASE_URL}`);
});

function shutdown(signal: NodeJS.Signals): void {
  server.close((error) => {
    if (error) {
      console.error(`Nib failed to shut down after ${signal}`, error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const retentionSweep = () => runRetentionSweep().catch((error) => console.error("retention sweep failed", error));
void retentionSweep();
setInterval(retentionSweep, 60 * 60 * 1000).unref();

async function handleRequestRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/requests")) return false;
  if (url.pathname === "/api/requests") {
    if (req.method === "GET") {
      sendJson(res, await listRequests(url.searchParams.get("projectId") ?? undefined, url.searchParams.get("includeMissing") !== "0"));
      return true;
    }
    if (req.method === "POST") {
      sendJson(res, await createRequest(await readJsonBody(req)), 201);
      return true;
    }
    return false;
  }
  if (url.pathname === "/api/requests/events" && req.method === "GET") {
    streamRequestEvents(res);
    return true;
  }

  const match = url.pathname.match(/^\/api\/requests\/([^/]+)(?:\/(respond|publish|attachments|response-attachments|notification-click))?$/);
  if (!match) return false;
  const requestId = decodeURIComponent(match[1] ?? "");
  const action = match[2];
  if (!action && req.method === "GET") {
    sendRequestResult(res, await getRequest(requestId));
    return true;
  }
  if (!action && req.method === "PATCH") {
    sendRequestResult(res, await patchRequest(requestId, await readJsonBody(req)));
    return true;
  }
  if (action === "respond" && req.method === "POST") {
    sendRequestResult(res, await respondRequest(requestId, await readJsonBody(req)));
    return true;
  }
  if (action === "publish" && req.method === "POST") {
    sendRequestResult(res, await publishRequest(requestId));
    return true;
  }
  if ((action === "attachments" || action === "response-attachments") && req.method === "POST") {
    const contentType = String(req.headers["content-type"] ?? "").split(";")[0]?.trim();
    if (contentType === "application/json" || !contentType) {
      const input = await readJsonBody<Record<string, unknown>>(req);
      if (action === "response-attachments") {
        input.metadata = { ...(asRecord(input.metadata)), role: "response" };
      }
      sendRequestResult(res, await addRequestAttachment(requestId, input), 201);
    } else {
      sendRequestResult(res, await streamRequestAttachment(req, requestId, action === "response-attachments"), 201);
    }
    return true;
  }
  if (action === "notification-click" && req.method === "POST") {
    sendRequestResult(res, await markRequestNotificationClicked(requestId));
    return true;
  }
  return false;
}

function sendRequestResult(res: http.ServerResponse, item: unknown, statusCode = 200): void {
  if (!item) sendJson(res, { error: "Request not found" }, 404);
  else sendJson(res, item, statusCode);
}

function sendJson(res: http.ServerResponse, payload: unknown, statusCode = 200): void {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache"
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: http.ServerResponse, html: string, statusCode = 200): void {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache"
  });
  res.end(html);
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-nib-filename,x-nib-metadata"
  };
}

function appleAppSiteAssociation(): Record<string, unknown> {
  return {
    applinks: {
      apps: [],
      details: [{
        appID: IOS_APP_ID,
        paths: ["/r/*"]
      }]
    }
  };
}

function isIOSBrowser(req: http.IncomingMessage): boolean {
  return /iPhone|iPad|iPod/i.test(req.headers["user-agent"] ?? "");
}

function nativeRequestUrl(requestId: string): string {
  const url = new URL(`nib://request/${encodeURIComponent(requestId)}`);
  url.searchParams.set("server", PUBLIC_BASE_URL);
  return url.toString();
}

function feedbackLabHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Feedback Lab</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #11151b; color: #f7f8fa; }
    body { margin: 0; min-height: 100dvh; background: #11151b; }
    main { min-height: 100dvh; display: grid; align-content: center; gap: 18px; padding: calc(18px + env(safe-area-inset-top)) calc(18px + env(safe-area-inset-right)) calc(18px + env(safe-area-inset-bottom)) calc(18px + env(safe-area-inset-left)); }
    section { display: grid; gap: 12px; padding: 16px; border: 1px solid #2c333d; border-radius: 16px; background: #151a21; box-shadow: 0 18px 45px rgba(9, 12, 18, 0.35); }
    h1 { margin: 0; font-size: clamp(2rem, 12vw, 4rem); line-height: 0.95; }
    p { margin: 0; color: #b7c1cf; line-height: 1.45; }
    button { min-height: 44px; border: 0; border-radius: 10px; background: #edf2f7; color: #11151b; font: inherit; font-weight: 700; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .metrics div { padding: 10px; border-radius: 10px; background: #202832; }
    strong { display: block; font-size: 1.2rem; }
    small { color: #8d99aa; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Feedback Lab</h1>
      <p>This built-in project exists so nib can test the fastest path from agent question to human answer without relying on another dev server.</p>
      <div class="metrics">
        <div><strong>1</strong><small>Tap to open</small></div>
        <div><strong>30px</strong><small>Hidden sheet</small></div>
        <div><strong>Goal</strong><small>Less friction</small></div>
      </div>
      <button onclick="document.body.dataset.clicked='true'; this.textContent='Ready for feedback';">Try action</button>
    </section>
  </main>
</body>
</html>`;
}

async function streamRequestAttachment(
  req: http.IncomingMessage,
  requestId: string,
  responseAttachment: boolean
) {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (declaredLength > ATTACHMENT_MAX_BYTES) {
    throw new RequestContractError(`attachment exceeds ${ATTACHMENT_MAX_BYTES} byte limit`, 413);
  }
  await fs.promises.mkdir(ATTACHMENT_DIR, { recursive: true });
  const temporaryFile = path.join(ATTACHMENT_DIR, `.upload-${crypto.randomUUID()}.tmp`);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > ATTACHMENT_MAX_BYTES) {
        callback(new RequestContractError(`attachment exceeds ${ATTACHMENT_MAX_BYTES} byte limit`, 413));
        return;
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(temporaryFile, { flags: "wx" }));
    const metadata = {
      ...parseHeaderRecord(req.headers["x-nib-metadata"]),
      ...(responseAttachment ? { role: "response" } : {})
    };
    return await addRequestAttachmentFile(
      requestId,
      {
        name: headerValue(req.headers["x-nib-filename"]) || "attachment",
        contentType: String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim(),
        metadata
      },
      temporaryFile,
      bytes
    );
  } finally {
    await fs.promises.unlink(temporaryFile).catch(() => undefined);
  }
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function parseHeaderRecord(value: string | string[] | undefined): Record<string, unknown> {
  const raw = headerValue(value);
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    throw new RequestContractError("x-nib-metadata must be valid JSON", 400);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve((raw ? JSON.parse(raw) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
