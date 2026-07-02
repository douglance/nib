import { useEffect, useState } from "react";
import type { RequestRecord } from "../../shared/types";
import { assetUrl, prtlFetch } from "../native";

const ANSWERED_STATUSES = new Set(["answered", "acted", "resolved"]);

function isAnswered(request: RequestRecord): boolean {
  return ANSWERED_STATUSES.has(request.status) || request.responses.length > 0;
}

function isOpen(request: RequestRecord): boolean {
  return !isAnswered(request) && ["open", "viewed", "stale"].includes(request.status);
}

export function App() {
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function loadRequests() {
    try {
      const response = await prtlFetch("/api/requests");
      if (response.ok) setRequests(await response.json() as RequestRecord[]);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void loadRequests();
    const interval = window.setInterval(() => void loadRequests(), 6000);
    const onFocus = () => void loadRequests();
    const onVisibility = () => {
      if (!document.hidden) void loadRequests();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const selected = selectedId ? requests.find((request) => request.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <RequestDetail
        request={selected}
        onBack={() => setSelectedId(null)}
        onUpdated={(updated) =>
          setRequests((current) => current.map((item) => (item.id === updated.id ? updated : item)))
        }
      />
    );
  }

  const open = requests.filter(isOpen);

  return (
    <main className="shell">
      <header className="topBar">
        <div>
          <h1>prtl</h1>
          <p>{open.length ? `${open.length} open request${open.length === 1 ? "" : "s"}` : "No open requests"}</p>
        </div>
        <NotificationsButton />
      </header>
      <section className="requestList" aria-live="polite">
        {open.map((request) => (
          <button key={request.id} className="requestRow" onClick={() => setSelectedId(request.id)}>
            <strong>{request.title}</strong>
            <span>{requestMeta(request)}</span>
          </button>
        ))}
        {loaded && !open.length ? <p className="emptyState">Nothing is waiting on you.</p> : null}
      </section>
    </main>
  );
}

function RequestDetail({
  request,
  onBack,
  onUpdated
}: {
  request: RequestRecord;
  onBack: () => void;
  onUpdated: (request: RequestRecord) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answered = isAnswered(request);
  const response = request.responses[0];
  const answeredLabel = response ? response.choice || response.text : request.status;
  const images = request.attachments.filter(
    (item) => item.url && (item.type === "image" || item.type === "screenshot" || item.contentType.startsWith("image/"))
  );

  async function respond(payload: { choice?: string; text?: string }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await prtlFetch(`/api/requests/${encodeURIComponent(request.id)}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      onUpdated(await result.json() as RequestRecord);
      setText("");
    } catch (respondError) {
      setError(respondError instanceof Error ? respondError.message : "Response failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell detail">
      <button className="backButton" onClick={onBack}>&larr; Requests</button>
      <header>
        <h1>{request.title}</h1>
        <p className="meta">{requestMeta(request)}</p>
      </header>
      <p className="prompt">{request.prompt}</p>
      {request.context ? <pre className="context">{request.context}</pre> : null}
      {images.length ? (
        <section className="attachments">
          {images.map((item) => (
            <img key={item.id} src={assetUrl(item.url) ?? item.url} alt={item.name} loading="lazy" />
          ))}
        </section>
      ) : null}
      {answered ? (
        <div className="answered">answered: {answeredLabel || "(empty)"}</div>
      ) : (
        <section className="controls">
          {request.choices.map((choice, index) => (
            <button key={`${choice}-${index}`} disabled={busy} onClick={() => void respond({ choice })}>
              {choice}
            </button>
          ))}
          {request.allowText ? (
            <form
              autoComplete="off"
              onSubmit={(event) => {
                event.preventDefault();
                if (text.trim()) void respond({ text: text.trim() });
              }}
            >
              <input
                type="text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Type a response"
                aria-label="Response"
                disabled={busy}
              />
              <button type="submit" disabled={busy}>Send</button>
            </form>
          ) : null}
          <p className="statusLine">{busy ? "sending…" : error ? `failed: ${error}` : ""}</p>
        </section>
      )}
    </main>
  );
}

function NotificationsButton() {
  const [state, setState] = useState<"unknown" | "unavailable" | "off" | "on">("unknown");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        setState("unavailable");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      setState((await registration.pushManager.getSubscription()) ? "on" : "off");
    })();
  }, []);

  async function enableNotifications() {
    try {
      setMessage(null);
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage("Notifications are not enabled.");
        return;
      }
      const [{ publicKey }, registration] = await Promise.all([
        prtlFetch("/api/notifications/vapid-public-key").then((response) => response.json() as Promise<{ publicKey: string }>),
        navigator.serviceWorker.ready
      ]);
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(publicKey)
        }));
      await prtlFetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() })
      });
      setState("on");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Notification setup failed.");
    }
  }

  if (state !== "off") return message ? <p className="statusLine">{message}</p> : null;
  return (
    <div className="notifySetup">
      <button className="notifyButton" onClick={() => void enableNotifications()}>
        Enable notifications
      </button>
      {message ? <p className="statusLine">{message}</p> : null}
    </div>
  );
}

function requestMeta(request: RequestRecord): string {
  const project = request.target.projectName ?? request.target.projectId;
  return [formatAge(request.createdAt), project].filter(Boolean).join(" · ");
}

function formatAge(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes.buffer as ArrayBuffer;
}
