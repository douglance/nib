import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "../apps/cloudflare/node_modules/typescript/lib/typescript.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "apps/cloudflare/src/review-page.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { reviewPageHtml } = await import(moduleUrl);

const host = "127.0.0.1";
const port = Number.parseInt(process.env.NIB_VISUAL_PORT || "8767", 10);
const origin = `http://${host}:${port}`;
const requestId = "req_checkout_review";
// The attached evidence is a real capture of this repository's pricing page.
// Run scripts/capture-site-visual.mjs first, or point NIB_VISUAL_ARTIFACT at
// another real capture. Nothing here is a mock-up.
const imagePath =
  process.env.NIB_VISUAL_ARTIFACT ||
  path.join(root, ".visual/final/pricing-desktop-fold.png");
if (!fs.existsSync(imagePath)) {
  throw new Error(
    `Missing evidence capture ${imagePath}. Run: node scripts/capture-site-visual.mjs .visual/final`,
  );
}
const image = fs.readFileSync(imagePath);

const request = {
  id: requestId,
  title: "Approve the new pricing page",
  description:
    "Check the plan hierarchy, the free-tier framing, and the primary action before this ships.",
  artifacts: [
    {
      id: "art_checkout",
      type: "image",
      name: "pricing-page.png",
      title: "Pricing page - desktop",
      contentType: "image/png",
    },
    {
      id: "art_diff",
      type: "file",
      name: "pricing.patch",
      title: "Code diff - 12 lines",
      contentType: "text/x-diff",
    },
  ],
};

// A second fixture with no image artifact keeps the decision and sent states
// short enough to capture the status pill and the action row in one frame.
const compactId = "req_release_gate";
const compact = {
  id: compactId,
  title: "Ship migration 0042 to production",
  description:
    "The agent finished the schema migration and is paused until a human decides.",
  artifacts: [
    {
      id: "art_migration",
      type: "file",
      name: "0042-add-request-index.sql",
      title: "Migration diff - 34 lines",
      contentType: "text/x-diff",
    },
  ],
};
const requests = new Map([
  [requestId, request],
  [compactId, compact],
]);

const server = http.createServer((incoming, response) => {
  const url = new URL(incoming.url || "/", origin);
  const sendJson = (body, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  if (url.pathname === "/health") {
    sendJson({ ok: true });
    return;
  }
  const routed = url.pathname.startsWith("/r/")
    ? url.pathname.slice(3)
    : url.pathname.split("/")[3];
  const active = requests.get(routed);

  if (url.pathname === `/r/${routed}` && active) {
    const state = url.searchParams.get("state") || "ready";
    const note = url.searchParams.get("note") || "";
    const stateScript = `<script>
      addEventListener("load", () => setTimeout(() => {
        const note = document.getElementById("comment");
        if (${JSON.stringify(state)} === "comment" || ${JSON.stringify(state)} === "approved") {
          note.value = ${JSON.stringify(note || "Keep the current payment selector, then this is ready to ship.")};
        }
        if (${JSON.stringify(state)} === "comment") {
          note.scrollIntoView({block: "center"});
        }
        if (${JSON.stringify(state)} === "approved") {
          document.querySelector('[data-outcome="approved"]').click();
          setTimeout(() => scrollTo({top: 0}), 150);
        }
      }, 350));
    </script>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      reviewPageHtml(routed, origin).replace("</body>", `${stateScript}</body>`),
    );
    return;
  }
  if (active && url.pathname === `/v1/requests/${routed}`) {
    sendJson({ request: active });
    return;
  }
  if (active && url.pathname === `/v1/requests/${routed}/artifacts`) {
    sendJson({ artifacts: active.artifacts });
    return;
  }
  if (
    url.pathname === `/v1/requests/${compactId}/artifacts/art_migration/content`
  ) {
    response.writeHead(200, {
      "content-type": "text/x-diff; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      "+ CREATE INDEX requests_open_idx ON requests (state, created_at);\n",
    );
    return;
  }
  if (active && url.pathname === `/v1/requests/${routed}/session`) {
    response.writeHead(204, {
      "set-cookie": "nib_review_session=visual; HttpOnly; SameSite=Strict; Path=/",
    });
    response.end();
    return;
  }
  if (
    url.pathname ===
    `/v1/requests/${requestId}/artifacts/art_checkout/content`
  ) {
    response.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
    });
    response.end(image);
    return;
  }
  if (
    url.pathname === `/v1/requests/${requestId}/artifacts/art_diff/content`
  ) {
    response.writeHead(200, {
      "content-type": "text/x-diff; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      "- <button>Continue</button>\n+ <button>Review and pay</button>\n",
    );
    return;
  }
  if (
    active &&
    (url.pathname === `/v1/requests/${routed}/feedback` ||
      url.pathname === `/v1/requests/${routed}/decisions`)
  ) {
    incoming.resume();
    sendJson({ ok: true });
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(port, host, () => {
  console.log(`${origin}/r/${requestId}#token=nib_review_visual`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
