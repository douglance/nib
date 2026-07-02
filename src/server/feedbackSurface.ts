import type { FeedbackRequest, FeedbackSurface } from "../shared/types";
import { validateFeedbackSurfaceHtml } from "../html/validate";

interface FeedbackSurfaceInput {
  prompt: string;
  context?: string | null;
  choices?: string[];
  responseMode?: string;
  responseSpec?: Record<string, unknown> | null;
  html?: string;
  title?: string | null;
  createdAt?: string;
}

export function createFeedbackSurface(input: FeedbackSurfaceInput): FeedbackSurface {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const html = input.html?.trim() || defaultFeedbackSurfaceHtml(input);
  const validation = validateFeedbackSurfaceHtml(html);
  if (!validation.valid) {
    const message = validation.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message)
      .join(" ");
    throw new Error(`Invalid feedback surface HTML: ${message || "unknown validation error"}`);
  }
  return {
    html,
    title: input.title?.trim() || validation.stats.title || "Feedback",
    version: 1,
    createdAt,
    validation
  };
}

export function feedbackSurfaceHtmlForNative(request: FeedbackRequest): string {
  const html = request.feedbackSurface?.html;
  if (!html) return "<!doctype html><html><body></body></html>";
  const bridge = `<script id="prtl-feedback-native-bridge">
(() => {
  if (window.prtl && window.prtl.feedback) return;
  const requestId = ${JSON.stringify(request.id)};
  const endpoint = (suffix) => "/api/feedback/" + encodeURIComponent(requestId) + suffix;
  async function send(path, payload = {}) {
    const response = await fetch(endpoint(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("prtl feedback failed: " + response.status);
    return response.json();
  }
  window.prtl = Object.assign(window.prtl || {}, {
    feedback: {
      ready(detail = {}) {
        document.documentElement.dataset.prtlFeedbackReady = "1";
        if (typeof detail.height === "number") this.resize(detail.height);
      },
      resize(height) {
        document.documentElement.dataset.prtlFeedbackHeight = String(height || "");
      },
      capture() {
        return send("/capture");
      },
      submit(payload = {}) {
        return send("/respond", {
          kind: payload.kind || "note",
          text: payload.text || payload.choice || "Feedback submitted",
          choice: payload.choice,
          data: payload.data || null
        });
      }
    }
  });
  function handleFeedbackMessage(message) {
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
    if (message.type === "prtl.feedback.capture") {
      window.prtl.feedback.capture();
      return;
    }
    if (message.type === "prtl.feedback.submit") {
      window.prtl.feedback.submit({
        kind: message.kind || "note",
        text: message.text || message.choice || "Feedback submitted",
        choice: message.choice,
        data: message.data || null
      });
    }
  }
  const originalPostMessage = window.postMessage.bind(window);
  window.postMessage = (message, targetOrigin, transfer) => {
    handleFeedbackMessage(message);
    return originalPostMessage(message, targetOrigin, transfer);
  };
  window.addEventListener("message", (event) => {
    handleFeedbackMessage(event.data || {});
  });
})();
</script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b([^>]*)>/i, `<head$1>${bridge}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b([^>]*)>/i, `<html$1>${bridge}`);
  return `${bridge}${html}`;
}

function defaultFeedbackSurfaceHtml(input: FeedbackSurfaceInput): string {
  const choices = input.choices?.map((choice) => choice.trim()).filter(Boolean) ?? [];
  const fieldNames = responseFieldNames(input.responseSpec);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Prtl feedback</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #151a21;
      --panel: #1c222b;
      --panel-2: #222832;
      --text: #f7f8fa;
      --muted: #b7c1cf;
      --line: #3a4350;
      --action: #edf2f7;
      --action-text: #11151b;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
    }
    main {
      display: grid;
      gap: 10px;
      padding: 2px;
    }
    header {
      display: grid;
      gap: 6px;
    }
    h1 {
      margin: 0;
      max-width: 44rem;
      font-size: 1.06rem;
      line-height: 1.34;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 0.84rem;
      line-height: 1.4;
    }
    .choices {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
      gap: 8px;
    }
    button {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    button:hover, button:focus-visible {
      border-color: #687589;
      outline: 0;
    }
    textarea, input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      font: inherit;
      padding: 10px 11px;
    }
    textarea {
      min-height: 84px;
      resize: vertical;
    }
    .fields {
      display: grid;
      gap: 8px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 0.78rem;
    }
    .bar {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .primary {
      background: var(--action);
      border-color: var(--action);
      color: var(--action-text);
      padding: 0 14px;
    }
    .ghost {
      padding: 0 12px;
    }
    .status {
      min-height: 22px;
      color: var(--muted);
      font-size: 0.8rem;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(input.prompt)}</h1>
      ${input.context ? `<p>${escapeHtml(input.context)}</p>` : ""}
    </header>
    ${choices.length ? `<section class="choices" aria-label="Choices">
      ${choices.map((choice) => `<button type="button" data-choice="${escapeAttr(choice)}">${escapeHtml(choice)}</button>`).join("\n      ")}
    </section>` : ""}
    ${fieldNames.length ? `<section class="fields" aria-label="Structured fields">
      ${fieldNames.map((field) => `<label>${escapeHtml(labelize(field))}<input data-field="${escapeAttr(field)}" autocomplete="off"></label>`).join("\n      ")}
    </section>` : ""}
    <textarea id="feedbackText" placeholder="${choices.length ? "Add detail" : "Type feedback"}"></textarea>
    <div class="bar">
      <button class="primary" id="send" type="button">Send</button>
      <button class="ghost" id="capture" type="button">Capture</button>
      <span class="status" id="status" role="status"></span>
    </div>
  </main>
  <script>
    const text = document.getElementById("feedbackText");
    const status = document.getElementById("status");
    let selectedChoice = "";

    function post(type, payload = {}) {
      const message = { type, ...payload };
      if (window.prtl && window.prtl.feedback) {
        if (type === "prtl.feedback.submit") {
          window.prtl.feedback.submit(payload);
          return;
        }
        if (type === "prtl.feedback.capture") {
          window.prtl.feedback.capture();
          return;
        }
        if (type === "prtl.feedback.resize") {
          window.prtl.feedback.resize(payload.height);
          return;
        }
        if (type === "prtl.feedback.ready") {
          window.prtl.feedback.ready(payload);
          return;
        }
      }
      window.parent.postMessage(message, "*");
    }

    function collectData() {
      const data = {};
      document.querySelectorAll("[data-field]").forEach((input) => {
        data[input.dataset.field] = input.value;
      });
      return data;
    }

    function submit(choice = selectedChoice) {
      const value = text.value.trim();
      const data = collectData();
      post("prtl.feedback.submit", {
        kind: "note",
        text: value || choice || "Feedback submitted",
        choice: choice || undefined,
        data: Object.keys(data).length ? data : null
      });
      status.textContent = "Sent";
    }

    document.querySelectorAll("[data-choice]").forEach((button) => {
      button.addEventListener("click", () => submit(button.dataset.choice || ""));
    });
    document.getElementById("send").addEventListener("click", () => submit());
    document.getElementById("capture").addEventListener("click", () => post("prtl.feedback.capture"));
    new ResizeObserver(() => post("prtl.feedback.resize", { height: document.documentElement.scrollHeight })).observe(document.body);
    post("prtl.feedback.ready", { height: document.documentElement.scrollHeight });
  </script>
</body>
</html>`;
}

function responseFieldNames(spec: Record<string, unknown> | null | undefined): string[] {
  if (!spec || typeof spec !== "object") return [];
  const fields = spec.fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter((field): field is string => typeof field === "string" && Boolean(field.trim())).slice(0, 8);
}

function labelize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
