import { canonicalAccountId } from "./account-inbox";

type ReviewAction = "page" | "data" | "respond" | "attachment";

export interface ReviewRoute {
  accountId: string;
  requestId: string;
  action: ReviewAction;
  attachmentId?: string;
}

export interface ReviewAttachmentLike {
  id: string;
  name?: string;
  type?: string;
  contentType?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

interface ReviewResponseLike {
  text?: string;
  choice?: string;
  data?: Record<string, unknown> | null;
}

export interface ReviewRecordLike {
  id: string;
  kind?: string;
  publishedAt?: string | null;
  title?: string;
  prompt?: string;
  status?: string;
  allowText?: boolean;
  source?: string | null;
  target?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  attachments?: ReviewAttachmentLike[];
  responses?: ReviewResponseLike[];
}

export interface PublicReviewRecord {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  status: string;
  allowText: boolean;
  attachment: {
    name: string;
    type: string;
    contentType: string;
    url: string;
  } | null;
  response: {
    decision: string;
    comment: string | null;
  } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseReviewRoute(pathname: string): ReviewRoute | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const accountId = canonicalAccountId(parts[1] || "");
  if (parts[0] !== "r" || !accountId || !UUID.test(parts[2] || "")) {
    return null;
  }
  const requestId = parts[2].toLowerCase();
  if (parts.length === 3) return { accountId, requestId, action: "page" };
  if (parts.length === 4 && parts[3] === "data") return { accountId, requestId, action: "data" };
  if (parts.length === 4 && parts[3] === "respond") return { accountId, requestId, action: "respond" };
  if (parts.length === 5 && parts[3] === "attachments" && UUID.test(parts[4])) {
    return { accountId, requestId, action: "attachment", attachmentId: parts[4] };
  }
  return null;
}

export function reviewPath(origin: string, accountId: string, requestId: string): string {
  const canonical = canonicalAccountId(accountId);
  if (!canonical) throw new TypeError("Invalid Nib account ID");
  return `${origin.replace(/\/$/, "")}/r/${encodeURIComponent(canonical)}/${encodeURIComponent(requestId.toLowerCase())}`;
}

export function publicResponseUrl(origin: string, accountId: string, requestId: string): string {
  return `${reviewPath(origin, accountId, requestId)}/respond`;
}

export function isPublishedVisualReview(item: ReviewRecordLike): boolean {
  return string(item.kind) === "visual-review" && Boolean(string(item.publishedAt));
}

export function publicReviewRecord(item: ReviewRecordLike, accountId: string): PublicReviewRecord {
  const attachments = Array.isArray(item.attachments) ? item.attachments : [];
  const attachment = [...attachments].sort((left, right) => attachmentRank(left) - attachmentRank(right))[0];
  const firstResponse = Array.isArray(item.responses) ? item.responses[0] : undefined;
  const responseData = record(firstResponse?.data);
  const decision = string(responseData.decision) || string(firstResponse?.choice);
  const comment = string(responseData.comment) || string(firstResponse?.text);

  return {
    id: item.id,
    kind: string(item.kind) || "visual-review",
    title: string(item.title) || "Nib review",
    prompt: string(item.prompt) || "Review this item",
    status: string(item.status) || "open",
    allowText: item.allowText !== false,
    attachment: attachment ? {
      name: string(attachment.name) || "Review attachment",
      type: string(attachment.type) || "file",
      contentType: string(attachment.contentType) || "application/octet-stream",
      url: publicAttachmentUrl(accountId, item.id, attachment)
    } : null,
    response: firstResponse ? {
      decision: decision || "comment",
      comment: comment || null
    } : null
  };
}

export function reviewPage(accountId: string, requestId: string): Response {
  const basePath = `/r/${encodeURIComponent(accountId)}/${encodeURIComponent(requestId)}`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="data:,">
  <title>Nib review</title>
  <style>
    :root {
      color-scheme: dark;
      --color-bg: #101010;
      --color-canvas: #181818;
      --color-surface: #2c2c2ce8;
      --color-text: #f2f2f2;
      --color-muted: #cccccc;
      --color-hairline: #ffffff24;
      --color-focus: #0078d4;
      --color-approve: #2e7d32;
      --color-reject: #c62828;
      --color-neutral: #4a4a4a;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--color-bg);
      color: var(--color-text);
    }
    * { box-sizing: border-box; }
    html, body { overflow-x: hidden; }
    body { margin: 0; min-height: 100vh; background: var(--color-bg); }
    button, textarea { font: inherit; }
    button:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
    .shell { width: 100%; max-width: 1120px; margin: 0 auto; padding: 32px 20px 48px; }
    .eyebrow { margin: 0 0 10px; color: var(--color-muted); font: 700 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(28px, 4vw, 40px); line-height: 1.08; letter-spacing: 0; }
    .prompt { max-width: 70ch; margin: 14px 0 0; color: var(--color-text); font-size: 17px; line-height: 1.6; }
    .workspace { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(300px, .75fr); gap: 20px; align-items: start; min-width: 0; margin-top: 28px; }
    .card { min-width: 0; overflow: hidden; border: 1px solid var(--color-hairline); border-radius: 8px; background: var(--color-canvas); box-shadow: 0 18px 70px rgba(0,0,0,.34); }
    .media { display: grid; width: 100%; max-width: 100%; min-height: 520px; place-items: center; background: #08080858; }
    .media img, .media video, .media embed { display: block; width: 100%; min-width: 0; max-width: 100%; height: auto; max-height: 72vh; object-fit: contain; }
    .media embed { min-height: 70vh; }
    .media-empty { padding: 48px 24px; color: var(--color-muted); text-align: center; }
    .response, .response form, .field, .actions { min-width: 0; max-width: 100%; }
    .response { padding: 20px; }
    .response h2 { margin: 0; font-size: 18px; letter-spacing: 0; }
    .field { display: grid; gap: 8px; margin-top: 18px; }
    label { color: var(--color-muted); font-size: 14px; font-weight: 650; }
    textarea { width: 100%; min-height: 132px; resize: vertical; border: 1px solid var(--color-hairline); border-radius: 8px; padding: 12px; background: var(--color-bg); color: var(--color-text); line-height: 1.5; }
    textarea::placeholder { color: #8f8f8f; }
    .actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 14px; }
    button { min-width: 0; min-height: 46px; border: 1px solid var(--color-hairline); border-radius: 8px; padding: 0 14px; cursor: pointer; background: var(--color-neutral); color: var(--color-text); font-weight: 700; }
    button:hover:not(:disabled) { filter: brightness(1.1); }
    button[data-decision="approve"] { border-color: transparent; background: var(--color-approve); color: white; }
    button[data-decision="reject"] { border-color: transparent; background: var(--color-reject); color: white; }
    button[data-decision="comment"] { grid-column: 1 / -1; }
    button:disabled, textarea:disabled { cursor: not-allowed; opacity: .5; }
    .status { min-height: 24px; margin: 14px 0 0; color: var(--color-muted); font-size: 14px; line-height: 1.5; }
    .status[data-tone="error"] { color: #ffb4b4; }
    .status[data-tone="success"] { color: #bfe7c1; }
    @media (max-width: 780px) {
      .shell { width: calc(100% - 32px); max-width: none; margin: 0 auto; padding: 22px 0 36px; }
      .workspace { grid-template-columns: minmax(0, 1fr); }
      .media { min-height: 320px; }
      .response { padding: 16px; }
      .actions { grid-template-columns: minmax(0, 1fr); }
    }
    @media (prefers-reduced-motion: no-preference) { button { transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease; } }
  </style>
</head>
<body>
  <main class="shell">
    <p class="eyebrow">Nib visual review</p>
    <h1 id="review-title">Loading review…</h1>
    <p class="prompt" id="review-prompt"></p>
    <section class="workspace" aria-label="Review workspace">
      <div class="card media" id="review-media" aria-busy="true"><p class="media-empty">Loading preview…</p></div>
      <aside class="card response">
        <h2>Your response</h2>
        <form id="response-form">
          <div class="field">
            <label for="review-comment">Comment <span aria-hidden="true">(optional)</span></label>
            <textarea id="review-comment" name="comment" placeholder="Add context or describe what should change"></textarea>
          </div>
          <div class="actions">
            <button type="submit" data-decision="approve">Approve</button>
            <button type="submit" data-decision="reject">Reject</button>
            <button type="submit" data-decision="comment">Send comment</button>
          </div>
        </form>
        <p class="status" id="review-status" aria-live="polite">Loading request…</p>
      </aside>
    </section>
  </main>
  <script>
    (() => {
      const basePath = ${JSON.stringify(basePath)};
      const title = document.querySelector("#review-title");
      const prompt = document.querySelector("#review-prompt");
      const media = document.querySelector("#review-media");
      const form = document.querySelector("#response-form");
      const comment = document.querySelector("#review-comment");
      const status = document.querySelector("#review-status");
      const controls = [...form.querySelectorAll("button, textarea")];

      const setStatus = (message, tone = "") => {
        status.textContent = message;
        status.dataset.tone = tone;
      };
      const setDisabled = (disabled) => controls.forEach((control) => { control.disabled = disabled; });
      const showAttachment = (attachment) => {
        media.replaceChildren();
        media.setAttribute("aria-busy", "false");
        if (!attachment) {
          const empty = document.createElement("p");
          empty.className = "media-empty";
          empty.textContent = "This review has no preview attachment.";
          media.append(empty);
          return;
        }
        let element;
        if (attachment.contentType.startsWith("image/")) {
          element = document.createElement("img");
          element.alt = attachment.name || "Review preview";
        } else if (attachment.contentType.startsWith("video/")) {
          element = document.createElement("video");
          element.controls = true;
        } else if (attachment.contentType === "application/pdf") {
          element = document.createElement("embed");
          element.type = "application/pdf";
          element.title = attachment.name || "PDF review";
        } else {
          const link = document.createElement("a");
          link.href = attachment.url;
          link.textContent = "Open " + (attachment.name || "attachment");
          element = link;
        }
        element.src = attachment.url;
        media.append(element);
      };
      const render = (review) => {
        title.textContent = review.title;
        prompt.textContent = review.prompt;
        showAttachment(review.attachment);
        if (review.response) {
          setDisabled(true);
          const detail = review.response.comment ? ": " + review.response.comment : "";
          setStatus("Response recorded - " + review.response.decision + detail, "success");
        } else {
          setDisabled(false);
          setStatus("Choose a decision or send a comment.");
        }
      };
      const load = async () => {
        const response = await fetch(basePath + "/data", { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(response.status === 404 ? "Review not found." : "Unable to load this review.");
        render(await response.json());
      };
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const decision = event.submitter?.dataset.decision || "comment";
        const message = comment.value.trim();
        if (decision === "comment" && !message) {
          setStatus("Write a comment before sending it.", "error");
          comment.focus();
          return;
        }
        setDisabled(true);
        setStatus("Sending response...");
        try {
          const response = await fetch(basePath + "/respond", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID()
            },
            body: JSON.stringify({ decision, comment: message || null })
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "Unable to send the response.");
          render(body);
        } catch (error) {
          setDisabled(false);
          setStatus(error instanceof Error ? error.message : "Unable to send the response.", "error");
        }
      });
      load().catch((error) => {
        media.setAttribute("aria-busy", "false");
        setDisabled(true);
        setStatus(error instanceof Error ? error.message : "Unable to load this review.", "error");
      });
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; media-src 'self'; frame-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}

export function publicAttachmentUrl(accountId: string, requestId: string, attachment: ReviewAttachmentLike): string {
  const original = new URL(string(attachment.url) || "/", "https://nib.invalid");
  const query = original.search;
  return `/r/${encodeURIComponent(accountId)}/${encodeURIComponent(requestId)}/attachments/${encodeURIComponent(attachment.id)}${query}`;
}

function attachmentRank(attachment: ReviewAttachmentLike): number {
  const role = string(attachment.metadata?.role);
  if (role === "preview" || role === "poster") return 0;
  if (role === "primary") return 1;
  if (string(attachment.contentType).startsWith("image/")) return 2;
  if (string(attachment.contentType).startsWith("video/") || attachment.contentType === "application/pdf") return 3;
  if (role === "canonical") return 10;
  return 5;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
