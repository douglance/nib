import type { RequestRecord, RequestResponse } from "../shared/types";

const ANSWERED_STATUSES = new Set(["answered", "acted", "resolved"]);

export function requestPageHtml(request: RequestRecord): string {
  const answered = ANSWERED_STATUSES.has(request.status) || request.responses.length > 0;
  const response = request.responses[0];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(request.title)}</title>
  <style>
    :root { color-scheme: dark light; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100dvh; font-family: system-ui, sans-serif; background: #11151b; color: #f7f8fa; }
    main { max-width: 640px; margin: 0 auto; display: grid; gap: 16px; padding: calc(20px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left)); }
    h1 { margin: 0; font-size: 1.4rem; line-height: 1.25; overflow-wrap: anywhere; }
    .prompt { margin: 0; color: #d5dce6; font-size: 1.05rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .meta { margin: 0; color: #8d99aa; font-size: 0.85rem; }
    pre.context { margin: 0; padding: 12px; border: 1px solid #2c333d; border-radius: 12px; background: #0b0e12; color: #c8d2de; font: 0.8rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .attachments { display: grid; gap: 10px; }
    .attachments img { max-width: 100%; height: auto; border-radius: 12px; border: 1px solid #2c333d; }
    #controls { display: grid; gap: 10px; }
    button { min-height: 52px; padding: 12px 16px; border: 0; border-radius: 12px; background: #edf2f7; color: #11151b; font: inherit; font-size: 1.05rem; font-weight: 700; cursor: pointer; overflow-wrap: anywhere; }
    button:active { opacity: 0.75; }
    button:disabled { opacity: 0.5; }
    form { display: flex; gap: 8px; }
    input[type="text"] { flex: 1; min-width: 0; min-height: 52px; padding: 12px 14px; border: 1px solid #2c333d; border-radius: 12px; background: #151a21; color: #f7f8fa; font: inherit; font-size: 1rem; }
    form button { flex: 0 0 auto; }
    .answered { padding: 14px 16px; border: 1px solid #2f5d3a; border-radius: 12px; background: #16241a; color: #a7e0b4; font-size: 1.05rem; font-weight: 600; overflow-wrap: anywhere; }
    .status-line { margin: 0; min-height: 1.2em; color: #e0a3a3; font-size: 0.9rem; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(request.title)}</h1>
      <p class="meta">${escapeHtml(metaLine(request))}</p>
    </header>
    <p class="prompt">${escapeHtml(request.prompt)}</p>
    ${request.context ? `<pre class="context">${escapeHtml(request.context)}</pre>` : ""}
    ${attachmentsHtml(request)}
    ${answered ? answeredHtml(request, response) : controlsHtml(request)}
  </main>
${answered ? "" : respondScript(request)}
</body>
</html>`;
}

function metaLine(request: RequestRecord): string {
  const parts = [request.target.projectName ?? request.target.projectId, request.kind, request.status];
  return parts.filter(Boolean).join(" · ");
}

function attachmentsHtml(request: RequestRecord): string {
  const images = request.attachments.filter(
    (item) => item.url && (item.type === "image" || item.type === "screenshot" || item.contentType.startsWith("image/"))
  );
  if (!images.length) return "";
  const tags = images
    .map((item) => `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" loading="lazy" />`)
    .join("\n      ");
  return `<section class="attachments">${tags}</section>`;
}

function answeredHtml(request: RequestRecord, response: RequestResponse | undefined): string {
  const label = response ? response.choice || response.text : request.status;
  return `<div class="answered">answered: ${escapeHtml(label || "(empty)")}</div>`;
}

function controlsHtml(request: RequestRecord): string {
  const buttons = request.choices
    .map((choice) => `<button type="button" data-choice="${escapeHtml(choice)}">${escapeHtml(choice)}</button>`)
    .join("\n      ");
  const form = request.allowText
    ? `<form id="text-form" autocomplete="off">
        <input type="text" name="text" placeholder="Type a response" aria-label="Response" />
        <button type="submit">Send</button>
      </form>`
    : "";
  return `<section id="controls">
      ${buttons}
      ${form}
      <p class="status-line" id="respond-status"></p>
    </section>`;
}

function respondScript(request: RequestRecord): string {
  return `  <script>
  (() => {
    const endpoint = "/api/requests/" + encodeURIComponent(${jsString(request.id)}) + "/respond";
    const controls = document.getElementById("controls");
    const statusLine = document.getElementById("respond-status");
    if (!controls) return;
    let busy = false;
    async function respond(payload, label) {
      if (busy) return;
      busy = true;
      for (const el of controls.querySelectorAll("button, input")) el.disabled = true;
      statusLine.textContent = "sending\\u2026";
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const done = document.createElement("div");
        done.className = "answered";
        done.textContent = "answered: " + label;
        controls.replaceWith(done);
      } catch (error) {
        statusLine.textContent = "failed: " + (error && error.message ? error.message : "unknown error");
        for (const el of controls.querySelectorAll("button, input")) el.disabled = false;
        busy = false;
      }
    }
    for (const button of controls.querySelectorAll("button[data-choice]")) {
      button.addEventListener("click", () => respond({ choice: button.dataset.choice }, button.dataset.choice));
    }
    const form = document.getElementById("text-form");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = form.elements.text.value.trim();
        if (text) respond({ text }, text);
      });
    }
  })();
  </script>`;
}

function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
