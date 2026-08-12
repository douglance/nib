export function reviewPageHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src 'self' https:",
      "media-src 'self' https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join("; ")
  };
}

export function reviewPageHtml(id: string, origin: string, apiPrefix = "/v1"): string {
  const encodedId = JSON.stringify(id);
  const encodedApiPrefix = JSON.stringify(apiPrefix.replace(/\/$/, ""));
  const native = `nib://request/${encodeURIComponent(id)}?server=${encodeURIComponent(origin)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Nib review</title>
  <style>
    :root{color-scheme:light;--page:#f6f4ef;--surface:#fffdfa;--ink:#171412;--muted:#625a52;--line:#ddd4c9;--focus:#0f766e;--ok:#166534;--error:#991b1b;--warn:#92400e}
    *{box-sizing:border-box}
    body{font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:var(--page);color:var(--ink)}
    main{width:min(100%,920px);margin:0 auto;padding:28px 20px 40px}
    h1{font-size:clamp(26px,4vw,40px);line-height:1.16;margin:0;letter-spacing:0;overflow-wrap:anywhere}
    p{margin:0}
    .status{display:inline-flex;align-items:center;min-height:40px;margin:0 0 18px;padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:rgba(255,253,250,.86);font-weight:650}
    .muted{color:var(--muted)}.error{color:var(--error)}.ok{color:var(--ok)}
    .review-shell{display:grid;gap:22px}
    .request-header{display:grid;gap:12px;padding-bottom:20px;border-bottom:1px solid var(--line)}
    .eyebrow{font-size:13px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
    .description{max-width:72ch;color:#342f2a;font-size:17px}
    .artifact-list{display:grid;gap:14px}
    .artifact-list:empty::before{content:"No artifacts attached.";display:block;padding:18px;border:1px dashed var(--line);border-radius:8px;color:var(--muted);background:rgba(255,253,250,.7)}
    .artifact{overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
    .artifact img,.artifact video{width:100%;max-width:100%;max-height:min(68vh,720px);display:block;object-fit:contain;background:#100f0e}
    .artifact a{display:block;min-height:48px;padding:13px 14px;color:#064e3b;font-weight:700;text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}
    .feedback{display:grid;gap:10px}
    .field-label{font-weight:750}
    textarea{width:100%;min-height:128px;padding:12px 14px;border:1px solid #b8afa4;border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;resize:vertical}
    textarea::placeholder{color:#746b62}
    .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}
    button{min-height:44px;padding:10px 16px;border:1px solid #2d2924;border-radius:8px;background:#2d2924;color:white;font:inherit;font-weight:750;cursor:pointer}
    button[data-action="comment"]{background:var(--surface);color:var(--ink);border-color:#8d8378}
    button[data-outcome="approved"]{background:var(--ok);border-color:var(--ok)}
    button[data-outcome="rejected"]{background:var(--surface);color:var(--error);border-color:#b91c1c}
    button[data-outcome="changes_requested"]{background:#fef3c7;color:var(--warn);border-color:#d97706}
    a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
    .app-link{display:inline-flex;align-items:center;min-height:44px;color:#064e3b;font-weight:750;text-decoration-thickness:1px;text-underline-offset:4px}
    @media (max-width:560px){
      main{padding:18px 14px 28px}
      .status{width:100%;border-radius:8px}
      .request-header{gap:10px}
      .description{font-size:16px}
      .actions{display:grid;grid-template-columns:1fr}
      button{width:100%}
    }
  </style>
</head>
<body>
<main>
  <p id="state" class="status muted" role="status" aria-live="polite">Loading review...</p>
  <section id="review" class="review-shell" aria-labelledby="title" hidden>
    <header class="request-header">
      <p class="eyebrow">Nib review</p>
      <h1 id="title"></h1>
      <p id="description" class="description"></p>
    </header>
    <div id="artifacts" class="artifact-list" aria-label="Review artifacts"></div>
    <div class="feedback">
      <label class="field-label" for="comment">Reviewer note</label>
      <textarea id="comment" placeholder="Add context for the requester"></textarea>
    </div>
    <div class="actions" aria-label="Review actions">
      <button type="button" data-action="comment">Comment</button>
      <button type="button" data-outcome="approved">Approve</button>
      <button type="button" data-outcome="rejected">Reject</button>
      <button type="button" data-outcome="changes_requested">Request changes</button>
    </div>
    <p><a class="app-link" href="${escapeAttribute(native)}">Open in Nib app</a></p>
  </section>
</main>
<script>
const requestId = ${encodedId};
const apiPrefix = ${encodedApiPrefix};
const state = document.getElementById("state");
const review = document.getElementById("review");
let token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
function requestBase() { return apiPrefix + "/requests/" + encodeURIComponent(requestId); }
function text(id, value) { document.getElementById(id).textContent = value || ""; }
function setState(message, className) { state.textContent = message; state.className = "status " + (className || "muted"); }
async function exchangeSession() {
  if (!token) return true;
  const response = await fetch(requestBase() + "/session", {
    method: "POST",
    credentials: "same-origin",
    headers: {"x-nib-capability": token}
  });
  token = "";
  history.replaceState(null, "", location.pathname);
  return response.ok;
}
function mergeArtifacts(...collections) {
  const merged = [];
  const seen = new Set();
  for (const artifact of collections.flatMap((collection) => collection || [])) {
    if (!artifact || seen.has(artifact.id)) continue;
    seen.add(artifact.id);
    merged.push(artifact);
  }
  return merged;
}
function safeArtifactUrl(artifact) {
  if (artifact.source && artifact.source.type === "external") {
    try {
      const url = new URL(artifact.source.url, location.href);
      if (["javascript:", "data:", "file:"].includes(url.protocol)) return "";
      if (url.protocol === "https:") return url.href;
      if (url.protocol === "http:" && url.origin === location.origin) return url.href;
      return "";
    } catch {
      return "";
    }
  }
  if (artifact.url) {
    try {
      const prefix = apiPrefix.endsWith("/v1") ? apiPrefix.slice(0, -3) : "";
      const url = new URL(prefix + artifact.url, location.href);
      return url.origin === location.origin ? url.href : "";
    } catch {
      return "";
    }
  }
  return requestBase() + "/artifacts/" + encodeURIComponent(artifact.id) + "/content";
}
function artifactKind(artifact) {
  if (artifact.type) return artifact.type;
  if ((artifact.contentType || "").startsWith("image/")) return "image";
  if ((artifact.contentType || "").startsWith("video/")) return "video";
  return "file";
}
function renderArtifact(artifact) {
  const url = safeArtifactUrl(artifact);
  if (!url) return;
  const kind = artifactKind(artifact);
  const item = document.createElement("div");
  item.className = "artifact";
  let node;
  if (kind === "image") { node = document.createElement("img"); node.src = url; node.alt = artifact.title || artifact.name || "Review image"; }
  else if (kind === "video") { node = document.createElement("video"); node.src = url; node.controls = true; node.setAttribute("aria-label", artifact.title || artifact.name || "Review video"); }
  else { node = document.createElement("a"); node.href = url; node.rel = "noreferrer noopener"; node.textContent = artifact.title || artifact.name || artifact.id || "Artifact"; }
  item.appendChild(node);
  document.getElementById("artifacts").appendChild(item);
}
async function load() {
  if (!await exchangeSession()) { setState("This review link is missing or expired.", "error"); return; }
  const response = await fetch(requestBase(), { credentials: "same-origin" });
  if (!response.ok) { setState(response.status === 401 || response.status === 403 ? "This review link is missing, expired, or revoked." : "Unable to load review.", "error"); return; }
  const snapshot = await response.json();
  const artifactsResponse = await fetch(requestBase() + "/artifacts", { credentials: "same-origin" });
  const hosted = artifactsResponse.ok ? await artifactsResponse.json() : { artifacts: [] };
  text("title", snapshot.request.title);
  text("description", snapshot.request.description || snapshot.request.prompt || "");
  for (const artifact of mergeArtifacts(snapshot.request.artifacts, hosted.artifacts, snapshot.request.attachments)) renderArtifact(artifact);
  review.hidden = false;
  setState("Ready", "ok");
}
async function postJson(path, body) {
  return fetch(requestBase() + path, {
    method: "POST",
    credentials: "same-origin",
    headers: {"content-type": "application/json", "idempotency-key": crypto.randomUUID()},
    body: JSON.stringify(body)
  });
}
async function comment() {
  setState("Sending...", "muted");
  const response = await postJson("/feedback", { kind: "comment", message: document.getElementById("comment").value });
  setState(response.ok ? "Sent." : "Unable to send comment.", response.ok ? "ok" : "error");
}
async function decide(outcome) {
  setState("Sending...", "muted");
  const response = await postJson("/decisions", { outcome, comment: document.getElementById("comment").value, terminal: true });
  setState(response.ok ? "Sent." : "Unable to send decision.", response.ok ? "ok" : "error");
}
document.querySelector("button[data-action='comment']").addEventListener("click", comment);
for (const button of document.querySelectorAll("button[data-outcome]")) {
  button.addEventListener("click", () => decide(button.dataset.outcome));
}
load().catch(() => setState("Unable to load review.", "error"));
</script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
