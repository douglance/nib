import {
  Bell,
  CheckCircle2,
  Copy,
  Edit3,
  ExternalLink,
  Home,
  Monitor,
  Power,
  RefreshCw,
  Route,
  Search,
  Server,
  ShieldAlert,
  Smartphone,
  Tablet,
  TriangleAlert
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type {
  FeedbackArtifact,
  FeedbackRequest,
  FeedbackResponseKind,
  HealthResponse,
  HtmlArtifactSummary,
  ProjectInfo,
  ProjectsResponse,
  ProjectWorkspace,
  RouteMode,
  ViewerState,
  ViewportKey
} from "../../shared/types";

const viewportIcons = {
  phone: Smartphone,
  tablet: Tablet,
  desktop: Monitor
};

const FEEDBACK_SYNC_EVENT = "prtl:feedback-sync";

interface FeedbackSyncDetail {
  removeId?: string;
  restore?: FeedbackRequest;
}

export function App() {
  const viewerProjectId = getViewerProjectId();
  const [data, setData] = useState<ProjectsResponse | null>(null);
  const [query, setQuery] = useState("");
  const [selectedViewport, setSelectedViewport] = useState<ViewportKey>("desktop");
  const [loading, setLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [killingId, setKillingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [artifacts, setArtifacts] = useState<HtmlArtifactSummary[]>([]);
  const [copied, setCopied] = useState(false);
  const autoCaptured = useRef(new Set<string>());

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects${refresh ? "?refresh=1" : ""}`);
      if (!response.ok) throw new Error(`Discovery failed: ${response.status}`);
      setData(await response.json());
      void loadHealth();
      void loadArtifacts();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Discovery failed");
    } finally {
      setLoading(false);
    }
  }

  async function loadHealth() {
    try {
      const response = await fetch("/api/health");
      if (response.ok) setHealth(await response.json());
    } catch {
      setHealth(null);
    }
  }

  async function loadArtifacts() {
    try {
      const response = await fetch("/api/html/artifacts");
      if (response.ok) {
        const payload = await response.json() as { artifacts: HtmlArtifactSummary[] };
        setArtifacts(payload.artifacts);
      }
    } catch {
      setArtifacts([]);
    }
  }

  async function copyInstallUrl() {
    const value = health?.publicBaseUrl ?? data?.publicBaseUrl;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function refreshScreenshots(projectId: string) {
    setRefreshingId(projectId);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/screenshots`, {
        method: "POST"
      });
      if (!response.ok) throw new Error(`Screenshot failed: ${response.status}`);
      const payload = await response.json();
      setData((current) => {
        if (!current) return current;
        return {
          ...current,
          projects: current.projects.map((project) =>
            project.id === projectId ? { ...project, screenshots: payload.screenshots } : project
          )
        };
      });
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "Screenshot failed");
    } finally {
      setRefreshingId(null);
    }
  }

  async function killProject(projectId: string) {
    setKillingId(projectId);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/kill`, {
        method: "POST"
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Kill failed: ${response.status}`);
      }
      await load(true);
    } catch (killError) {
      setError(killError instanceof Error ? killError.message : "Kill failed");
    } finally {
      setKillingId(null);
    }
  }

  async function setPreferredRoute(projectId: string, mode: RouteMode) {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/preferred-route`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode })
      });
      if (!response.ok) throw new Error(`Route update failed: ${response.status}`);
      const project = await response.json();
      setData((current) => {
        if (!current) return current;
        return {
          ...current,
          projects: current.projects.map((item) => (item.id === projectId ? project : item))
        };
      });
    } catch (routeError) {
      setError(routeError instanceof Error ? routeError.message : "Route update failed");
    }
  }

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void loadHealth(), 15000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!data) return;
    const pending = data.projects.filter(
      (project) => !autoCaptured.current.has(project.id) && !project.screenshots.desktop.capturedAt
    );
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const project of pending.slice(0, 8)) {
        if (cancelled) return;
        autoCaptured.current.add(project.id);
        await refreshScreenshots(project.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  const projects = useMemo(() => {
    const source = data?.projects ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((project) =>
      [project.name, project.framework, project.sourcePath, String(project.port)]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle))
    );
  }, [data, query]);

  const viewerProject = viewerProjectId ? data?.projects.find((project) => project.id === viewerProjectId) : null;
  if (viewerProjectId) {
    return (
      <ProjectViewer
        project={viewerProject}
        projects={data?.projects ?? []}
        loading={loading}
      />
    );
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <h1>prtl</h1>
          <p>{health?.publicBaseUrl ?? data?.publicBaseUrl ?? "Scanning local project servers"}</p>
          <div className="topMeta">
            <span className={health?.ok ? "healthPill good" : "healthPill warn"}>
              {health?.ok ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
              {health?.tailscaleServe === "configured" ? "HTTPS ready" : "Check HTTPS"}
            </span>
            <span className="healthPill">
              <Server size={15} />
              {health ? `${health.onlineProjectCount}/${health.projectCount} online` : "Checking"}
            </span>
          </div>
        </div>
        <div className="topActions">
          <FeedbackInbox />
          <button className="primaryButton" onClick={() => void copyInstallUrl()} disabled={!health && !data}>
            <Copy size={17} />
            {copied ? "Copied" : "Copy URL"}
          </button>
          <button className="primaryButton" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw size={17} />
            Refresh
          </button>
        </div>
      </header>

      <section className="controls" aria-label="Project controls">
        <label className="searchBox">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects, ports, paths"
          />
        </label>
        <div className="segmented" aria-label="Screenshot viewport">
          {(["desktop", "tablet", "phone"] as ViewportKey[]).map((viewport) => {
            const Icon = viewportIcons[viewport];
            return (
              <button
                key={viewport}
                className={selectedViewport === viewport ? "active" : ""}
                onClick={() => setSelectedViewport(viewport)}
                title={viewport}
              >
                <Icon size={17} />
                <span>{viewport}</span>
              </button>
            );
          })}
        </div>
      </section>

      {error ? <div className="notice">{error}</div> : null}
      {health?.warnings.length ? (
        <section className="notice">
          {health.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </section>
      ) : null}

      <section className="summaryBand">
        <strong>{projects.length}</strong>
        <span>{loading ? "Scanning..." : "active project servers"}</span>
        <span className="summaryDetail">
          {health ? `Uptime ${formatDuration(health.uptimeSeconds)} · Updated ${formatTime(health.generatedAt)}` : null}
        </span>
      </section>

      {artifacts.length ? (
        <section className="artifactGallery" aria-label="HTML artifacts">
          <header>
            <div>
              <h2>HTML Artifacts</h2>
              <p>{artifacts.length} registered artifact{artifacts.length === 1 ? "" : "s"}</p>
            </div>
            <a className="openButton" href="#projects">Projects</a>
          </header>
          <div className="artifactGalleryGrid">
            {artifacts.slice(0, 12).map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </section>
      ) : null}

      <section id="projects" className="projectGrid" aria-live="polite">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            viewport={selectedViewport}
            refreshing={refreshingId === project.id}
            killing={killingId === project.id}
            onRefresh={() => void refreshScreenshots(project.id)}
            onKill={() => void killProject(project.id)}
            onPreferredRoute={(mode) => void setPreferredRoute(project.id, mode)}
          />
        ))}
      </section>

      {!loading && projects.length === 0 ? (
        <section className="emptyState">
          <h2>No active web projects found</h2>
          <p>Start a local dev server and refresh this page.</p>
        </section>
      ) : null}
    </main>
  );
}

function ArtifactCard({ artifact }: { artifact: HtmlArtifactSummary }) {
  const screenshot = artifact.screenshots.desktop;
  const issueCount = artifact.validation?.issues.length ?? 0;
  return (
    <article className="artifactCard">
      <div className="artifactPreview">
        {screenshot.url ? <img src={screenshot.url} alt={`${artifact.name} screenshot`} /> : <span>No screenshot</span>}
      </div>
      <div className="artifactCardBody">
        <div>
          <h3>{artifact.name}</h3>
          <p>{artifact.artifactKind ?? "html-artifact"} · {artifact.hash ?? "no hash"}</p>
        </div>
        <span className={`artifactValidation ${artifact.validation?.valid === false ? "bad" : "good"}`}>
          {artifact.validation?.valid === false ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : "valid"}
        </span>
        <div className="artifactActions">
          <a className="openButton" href={artifact.viewerUrl}>View</a>
          <a className="openButton" href={artifact.artifactUrl}>Artifact</a>
        </div>
      </div>
    </article>
  );
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

interface ProjectCardProps {
  project: ProjectInfo;
  viewport: ViewportKey;
  refreshing: boolean;
  killing: boolean;
  onRefresh: () => void;
  onKill: () => void;
  onPreferredRoute: (mode: RouteMode) => void;
}

function ProjectCard({ project, viewport, refreshing, killing, onRefresh, onKill, onPreferredRoute }: ProjectCardProps) {
  const screenshot = project.screenshots[viewport];
  const preferred = project.routes[project.preferredRoute] ?? project.routes.pathProxy;
  const compatibilityClass = `compatBadge ${project.compatibility.level}`;
  return (
    <article className="projectCard">
      <div className="screenshotFrame">
        {screenshot.url ? (
          <img src={screenshot.url} alt={`${project.name} ${viewport} screenshot`} />
        ) : (
          <div className="screenshotEmpty">No screenshot</div>
        )}
      </div>
      <div className="cardBody">
        <div className="cardTitleRow">
          <div>
            <h2>{project.name}</h2>
            <p>
              {project.framework ?? "Web"} · {project.port ? `${project.host}:${project.port}` : project.targetKind}
              {project.processId ? ` · pid ${project.processId}` : ""}
            </p>
          </div>
          <span className="statusDot" title={project.status} />
        </div>
        <div className="compatRow">
          <span className={compatibilityClass}>
            <Route size={14} />
            {project.compatibility.level}
          </span>
          <span>{preferred?.label ?? "Proxy"} route</span>
        </div>
        {project.sourcePath ? <p className="pathLine">{project.sourcePath}</p> : null}
        <div className="routeButtons" aria-label={`${project.name} route options`}>
          {(["direct", "pathProxy"] as RouteMode[]).map((mode) => {
            const route = project.routes[mode];
            if (!route) return null;
            return (
              <button
                key={mode}
                className={project.preferredRoute === mode ? "active" : ""}
                disabled={!route.available}
                onClick={() => onPreferredRoute(mode)}
                title={route.message ?? route.label}
              >
                {route.label}
              </button>
            );
          })}
        </div>
        <div className="cardActions">
          <a className="openButton" href={`/view/${project.id}`}>
            <ExternalLink size={16} />
            View
          </a>
          <button className="iconButton" onClick={onRefresh} disabled={refreshing} title="Refresh screenshot">
            <RefreshCw size={16} className={refreshing ? "spinning" : ""} />
          </button>
          {project.killable ? (
            <button className="dangerButton" onClick={onKill} disabled={killing} title={`Kill ${project.name}`}>
              <Power size={16} className={killing ? "spinning" : ""} />
              Kill
            </button>
          ) : null}
        </div>
        <p className="shotMeta">
          {screenshot.error
            ? "Screenshot failed"
            : screenshot.capturedAt
              ? `Captured ${new Date(screenshot.capturedAt).toLocaleTimeString()}`
              : "Screenshot pending"}
        </p>
        <details className="compatDetails">
          <summary>Compatibility</summary>
          {project.compatibility.checks.map((check) => (
            <p key={check.id} className={`check ${check.status}`}>
              <span>{check.label}</span>
              {check.message}
            </p>
          ))}
        </details>
      </div>
    </article>
  );
}

function FeedbackInbox({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [notificationReady, setNotificationReady] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);

  async function loadFeedback() {
    setLoading(true);
    try {
      const response = await fetch("/api/feedback");
      if (response.ok) setFeedback(await response.json());
    } finally {
      setLoading(false);
    }
  }

  function applyFeedbackSync(detail?: FeedbackSyncDetail) {
    if (detail?.removeId) {
      setFeedback((current) => current.filter((request) => request.id !== detail.removeId));
      window.setTimeout(() => void loadFeedback(), 1500);
      return;
    }
    if (detail?.restore) {
      setFeedback((current) => [detail.restore!, ...current.filter((request) => request.id !== detail.restore!.id)]);
      window.setTimeout(() => void loadFeedback(), 800);
      return;
    }
    void loadFeedback();
  }

  async function loadNotificationStatus() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotificationReady(false);
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    setNotificationReady(Boolean(await registration.pushManager.getSubscription()));
  }

  useEffect(() => {
    void loadFeedback();
    void loadNotificationStatus();
    const interval = window.setInterval(() => void loadFeedback(), 8000);
    const onFocus = () => void loadFeedback();
    const onVisibility = () => {
      if (!document.hidden) void loadFeedback();
    };
    const onSync = (event: Event) => applyFeedbackSync((event as CustomEvent<FeedbackSyncDetail>).detail);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== FEEDBACK_SYNC_EVENT) return;
      try {
        applyFeedbackSync(event.newValue ? JSON.parse(event.newValue) as FeedbackSyncDetail : undefined);
      } catch {
        void loadFeedback();
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(FEEDBACK_SYNC_EVENT, onSync);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(FEEDBACK_SYNC_EVENT, onSync);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  async function enableNotifications() {
    try {
      setNotificationMessage(null);
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        setNotificationMessage("Notifications are not available in this browser.");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setNotificationMessage("Notifications are not enabled.");
        return;
      }
      const [{ publicKey }, registration] = await Promise.all([
        fetch("/api/notifications/vapid-public-key").then((response) => response.json() as Promise<{ publicKey: string }>),
        navigator.serviceWorker.ready
      ]);
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(publicKey)
        }));
      await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() })
      });
      const testResponse = await fetch("/api/notifications/test", { method: "POST" });
      const testPayload = await testResponse.json();
      setNotificationReady(true);
      setNotificationMessage(testPayload.sent ? "Notifications enabled. Latest request sent." : "Notifications enabled.");
    } catch (error) {
      setNotificationMessage(error instanceof Error ? error.message : "Notification setup failed.");
    }
  }

  async function testNotification() {
    const response = await fetch("/api/notifications/test", { method: "POST" });
    const payload = await response.json();
    setNotificationMessage(payload.sent ? "Test notification sent." : "No subscription is available yet.");
  }

  const pending = feedback.filter(isActiveFeedbackRequest);

  return (
    <div className={`feedbackInbox ${compact ? "compact" : ""}`}>
      <button
        className="feedbackInboxButton"
        onClick={() => {
          setOpen((value) => !value);
          void loadFeedback();
        }}
        title="Feedback requests"
      >
        <Bell size={17} />
        {compact ? null : <span>Feedback</span>}
        {pending.length ? <strong>{pending.length}</strong> : null}
      </button>
      {open ? (
        <section className="feedbackInboxMenu">
          <header>
            <span>Requests</span>
            <button onClick={() => void loadFeedback()} title="Refresh feedback">
              <RefreshCw size={14} className={loading ? "spinning" : ""} />
            </button>
          </header>
          <div className="feedbackInboxList">
            {!notificationReady ? (
              <button className="notificationSetupButton" onClick={() => void enableNotifications()}>
                Enable notifications
              </button>
            ) : (
              <button className="notificationSetupButton" onClick={() => void testNotification()}>
                Send latest request notification
              </button>
            )}
            {notificationMessage ? <p className="feedbackInboxEmpty">{notificationMessage}</p> : null}
            {pending.map((request) => (
              <a key={request.id} href={feedbackHref(request)}>
                <span className={`feedbackDot ${request.status}`} />
                <div>
                  <strong>{request.projectName}</strong>
                  <p>{request.prompt}</p>
                  <small>{request.status} · {request.appPath} · {formatTime(request.updatedAt)}</small>
                </div>
              </a>
            ))}
            {!pending.length ? <p className="feedbackInboxEmpty">No feedback requests.</p> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
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

function feedbackHref(request: FeedbackRequest): string {
  const params = new URLSearchParams({ path: request.appPath, feedback: request.id });
  return `/view/${encodeURIComponent(request.projectId)}?${params.toString()}`;
}

function isActiveFeedbackRequest(request: FeedbackRequest): boolean {
  return ["open", "viewed", "stale"].includes(request.status);
}

function latestFeedbackArtifacts(artifacts: FeedbackArtifact[]): FeedbackArtifact[] {
  const latestByViewport = new Map<string, FeedbackArtifact>();
  for (const artifact of [...artifacts].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))) {
    const key = artifact.viewport ?? artifact.label;
    if (!latestByViewport.has(key)) latestByViewport.set(key, artifact);
  }
  const order = new Map<string, number>([
    ["phone", 0],
    ["tablet", 1],
    ["desktop", 2]
  ]);
  return [...latestByViewport.values()].sort((a, b) => (order.get(a.viewport ?? "") ?? 9) - (order.get(b.viewport ?? "") ?? 9));
}

function broadcastFeedbackSync(detail: FeedbackSyncDetail = {}) {
  window.dispatchEvent(new CustomEvent<FeedbackSyncDetail>(FEEDBACK_SYNC_EVENT, { detail }));
  try {
    window.localStorage.setItem(FEEDBACK_SYNC_EVENT, JSON.stringify({ ...detail, at: new Date().toISOString() }));
  } catch {
    // Local refresh already happened; cross-tab sync is best effort.
  }
}

function withViewTransition(update: () => void) {
  const documentWithTransition = document as Document & {
    startViewTransition?: (callback: () => void) => { finished: Promise<void> };
  };
  if (typeof documentWithTransition.startViewTransition === "function") {
    void documentWithTransition.startViewTransition(update).finished.catch(() => undefined);
    return;
  }
  update();
}

function getViewerProjectId(): string | null {
  const match = window.location.pathname.match(/^\/view\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

interface ProjectViewerProps {
  project: ProjectInfo | null | undefined;
  projects: ProjectInfo[];
  loading: boolean;
}

function ProjectViewer({
  project,
  projects,
  loading
}: ProjectViewerProps) {
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [feedbackRequests, setFeedbackRequests] = useState<FeedbackRequest[]>([]);
  const [activeFeedback, setActiveFeedback] = useState<FeedbackRequest | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackFocused, setFeedbackFocused] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<FeedbackArtifact | null>(null);
  const [editStatus, setEditStatus] = useState<"idle" | "active" | "unavailable">("idle");
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  const [sheetOffset, setSheetOffset] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const sheetRef = useRef<HTMLElement | null>(null);
  const sheetDrag = useRef<{ startY: number; startOffset: number; maxOffset: number; moved: boolean } | null>(null);
  const targetFrameRef = useRef<HTMLIFrameElement | null>(null);
  const pendingResponseId = useRef<string | null>(null);
  const requestedFeedbackId = getQueryParam("feedback");
  const requestedAppPath = getQueryParam("path");

  useEffect(() => {
    if (!project) return;
    void loadViewerData(project.id);
  }, [project?.id, requestedFeedbackId]);

  useEffect(() => {
    if (!activeFeedback) return;
    const events = new EventSource(`/api/feedback/${encodeURIComponent(activeFeedback.id)}/events`);
    events.addEventListener("feedback", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as FeedbackRequest;
      if (isActiveFeedbackRequest(next)) {
        setActiveFeedback(next);
        setFeedbackRequests((current) => [next, ...current.filter((item) => item.id !== next.id && isActiveFeedbackRequest(item))]);
      } else {
        setFeedbackRequests((current) => {
          const remaining = current.filter((item) => item.id !== next.id && isActiveFeedbackRequest(item));
          setActiveFeedback(remaining[0] ?? null);
          return remaining;
        });
      }
      broadcastFeedbackSync();
    });
    return () => events.close();
  }, [activeFeedback?.id]);

  useEffect(() => {
    window.setTimeout(() => enableEditableTarget(), 80);
  }, [activeFeedback?.id, frameKey, project?.id, requestedAppPath]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!targetFrameRef.current?.contentWindow || event.source !== targetFrameRef.current.contentWindow) return;
      const message = normalizeTargetEditMessage(event.data);
      if (!message || !activeFeedback) return;
      void recordTargetEdit(message);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [activeFeedback?.id]);

  useEffect(() => {
    if (!sheetCollapsed) return;
    const frame = window.requestAnimationFrame(() => {
      setSheetOffset(getSheetMaxOffset());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sheetCollapsed, activeFeedback?.id]);

  async function loadViewerData(projectId: string) {
    const [workspaceResponse, feedbackResponse] = await Promise.all([
      fetch(`/api/projects/${encodeURIComponent(projectId)}/workspace`),
      requestedFeedbackId
        ? fetch(`/api/feedback/${encodeURIComponent(requestedFeedbackId)}?viewed=1`)
        : fetch(`/api/feedback?projectId=${encodeURIComponent(projectId)}`)
    ]);
    if (workspaceResponse.ok) {
      const nextWorkspace = await workspaceResponse.json();
      setWorkspace(nextWorkspace);
      const nextCollapsed = requestedFeedbackId ? false : nextWorkspace.viewer.drawer === "collapsed";
      setSheetCollapsed(nextCollapsed);
      window.requestAnimationFrame(() => {
        setSheetOffset(nextCollapsed ? getSheetMaxOffset() : 0);
      });
    }
    if (feedbackResponse.ok) {
      const payload = await feedbackResponse.json();
      if (Array.isArray(payload)) {
        setFeedbackRequests(payload);
        setActiveFeedback(payload.find(isActiveFeedbackRequest) ?? null);
      } else {
        setActiveFeedback(isActiveFeedbackRequest(payload) ? payload : null);
        setFeedbackRequests(isActiveFeedbackRequest(payload) ? [payload] : []);
      }
      broadcastFeedbackSync();
    }
  }

  async function saveViewerState(patch: Partial<ViewerState>) {
    if (!project || !workspace) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/workspace`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewer: patch })
    });
    if (response.ok) setWorkspace(await response.json());
  }

  async function respondToFeedback(
    kind: FeedbackResponseKind,
    text = feedbackText,
    choice?: string,
    data?: Record<string, unknown> | null
  ) {
    if (!activeFeedback) return;
    if (pendingResponseId.current === activeFeedback.id) return;
    const request = activeFeedback;
    const previousText = feedbackText;
    pendingResponseId.current = request.id;
    setFeedbackError(null);
    withViewTransition(() => {
      setFeedbackRequests((current) => {
        const remaining = current.filter((item) => item.id !== request.id && isActiveFeedbackRequest(item));
        setActiveFeedback(remaining[0] ?? null);
        return remaining;
      });
      setFeedbackText("");
      setFeedbackFocused(false);
    });
    broadcastFeedbackSync({ removeId: request.id });
    try {
      const response = await fetch(`/api/feedback/${encodeURIComponent(request.id)}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, text, choice, data })
      });
      if (!response.ok) throw new Error(`Feedback failed: ${response.status}`);
      window.setTimeout(() => broadcastFeedbackSync(), 1500);
    } catch (error) {
      withViewTransition(() => {
        setActiveFeedback(request);
        setFeedbackRequests((current) => [request, ...current.filter((item) => item.id !== request.id)]);
        setFeedbackText(previousText);
        setFeedbackFocused(Boolean(previousText));
      });
      setFeedbackError(error instanceof Error ? error.message : "Feedback failed.");
      broadcastFeedbackSync({ restore: request });
    } finally {
      if (pendingResponseId.current === request.id) pendingResponseId.current = null;
    }
  }

  function chooseFeedback(choice: string) {
    const note = feedbackText.trim();
    void respondToFeedback("note", note || choice, choice);
  }

  async function captureFeedback() {
    if (!activeFeedback) return;
    const response = await fetch(`/api/feedback/${encodeURIComponent(activeFeedback.id)}/capture`, { method: "POST" });
    if (response.ok) {
      const next = await response.json();
      setActiveFeedback(next);
      setFeedbackRequests((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      broadcastFeedbackSync();
    }
  }

  async function updateFeedbackStatus(status: FeedbackRequest["status"]) {
    if (!activeFeedback) return;
    const response = await fetch(`/api/feedback/${encodeURIComponent(activeFeedback.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status })
    });
    if (response.ok) {
      const next = await response.json();
      setActiveFeedback(next);
      setFeedbackRequests((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      broadcastFeedbackSync();
    }
  }

  function enableEditableTarget() {
    if (!activeFeedback) {
      setEditStatus("idle");
      setEditMessage(null);
      return;
    }
    const frame = targetFrameRef.current;
    if (!frame?.contentDocument) {
      setEditStatus("unavailable");
      setEditMessage("Editable mode unavailable for this route.");
      return;
    }
    try {
      installEditableTargetBridge(frame.contentWindow, frame.contentDocument);
      setEditStatus("active");
      setEditMessage("Editable mode active");
    } catch {
      setEditStatus("unavailable");
      setEditMessage("Editable mode unavailable for cross-origin content.");
    }
  }

  async function recordTargetEdit(edit: TargetEditMessage) {
    if (!activeFeedback) return;
    const response = await fetch(`/api/feedback/${encodeURIComponent(activeFeedback.id)}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(edit)
    });
    if (response.ok) {
      const next = await response.json() as FeedbackRequest;
      setActiveFeedback(next);
      setFeedbackRequests((current) => [next, ...current.filter((item) => item.id !== next.id && isActiveFeedbackRequest(item))]);
      broadcastFeedbackSync();
    }
  }

  function getSheetMaxOffset(): number {
    const drawer = sheetRef.current;
    if (!drawer) return 0;
    const paddingBottom = Number.parseFloat(window.getComputedStyle(drawer).paddingBottom) || 0;
    return Math.max(0, drawer.getBoundingClientRect().height - 30 - paddingBottom);
  }

  function setSheetPosition(offset: number, maxOffset = getSheetMaxOffset()) {
    setSheetOffset(Math.min(maxOffset, Math.max(0, offset)));
  }

  function beginSheetDrag(event: PointerEvent<HTMLButtonElement>) {
    const maxOffset = getSheetMaxOffset();
    sheetDrag.current = {
      startY: event.clientY,
      startOffset: Math.min(sheetOffset, maxOffset),
      maxOffset,
      moved: false
    };
    setSheetDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveSheetDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = sheetDrag.current;
    if (!drag) return;
    const delta = event.clientY - drag.startY;
    if (Math.abs(delta) > 3) drag.moved = true;
    setSheetPosition(drag.startOffset + delta, drag.maxOffset);
  }

  function endSheetDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = sheetDrag.current;
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const delta = event.clientY - drag.startY;
    const currentOffset = Math.min(drag.maxOffset, Math.max(0, drag.startOffset + delta));
    const nextCollapsed = drag.moved ? delta > 10 : !sheetCollapsed;
    const nextOffset = nextCollapsed ? drag.maxOffset : 0;
    sheetDrag.current = null;
    setSheetDragging(false);
    setSheetCollapsed(nextCollapsed);
    setSheetPosition(nextOffset, drag.maxOffset);
    void saveViewerState({ drawer: nextCollapsed ? "collapsed" : "half", activeTab: "feedback" });
  }

  function cancelSheetDrag() {
    sheetDrag.current = null;
    setSheetDragging(false);
  }

  if (loading && !project) {
    return <main className="viewerShell viewerLoading">Loading project...</main>;
  }

  if (!project) {
    return (
      <main className="viewerShell viewerLoading">
        <p>Project not found.</p>
        <a className="openButton" href="/">
          <Home size={16} />
          Portal
        </a>
      </main>
    );
  }

  const appPath = requestedAppPath ?? activeFeedback?.appPath ?? "/";
  const preferred = project.routes[project.preferredRoute] ?? project.routes.pathProxy;
  const frameRoute = project.targetKind === "website" || (preferred?.mode === "direct" && preferred.url.startsWith("https:"))
    ? preferred
    : project.routes.pathProxy;
  const externalRoute = preferred ?? project.routes.pathProxy;
  const frameSrc = appendAppPath(frameRoute?.url ?? project.openPath, appPath);
  const externalSrc = appendAppPath(externalRoute?.url ?? project.openPath, appPath);
  const visibleArtifacts = latestFeedbackArtifacts(activeFeedback?.artifacts ?? []);

  return (
    <main className="viewerShell">
      <header className="viewerTopbar">
        <a className="viewerIconButton" href="/" title="Portal">
          <Home size={18} />
        </a>
        <select
          value={project.id}
          onChange={(event) => {
            window.location.href = `/view/${event.target.value}`;
          }}
        >
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}{item.port ? ` :${item.port}` : ""}
            </option>
          ))}
        </select>
        <span className={`compatBadge ${project.compatibility.level}`}>
          <Route size={14} />
          {project.compatibility.level}
        </span>
        <FeedbackInbox compact />
        <span className={`editModeBadge ${editStatus}`}>
          <Edit3 size={14} />
          {editStatus === "active" ? `Edit ${activeFeedback?.edits?.length ?? 0}` : "Edit"}
        </span>
        <button className="viewerIconButton" onClick={() => setFrameKey((value) => value + 1)} title="Reload app">
          <RefreshCw size={17} />
        </button>
        <a className="viewerIconButton" href={externalSrc} target="_blank" rel="noreferrer" title="Open external">
          <ExternalLink size={17} />
        </a>
      </header>

      <section className="viewerFrameWrap">
        <iframe
          ref={targetFrameRef}
          key={frameKey}
          title={project.name}
          allow="microphone; camera; display-capture; autoplay"
          src={frameSrc}
          onLoad={() => enableEditableTarget()}
        />
      </section>

        <aside
          ref={sheetRef}
          className={`viewerDrawer ${sheetDragging ? "dragging" : ""} ${sheetCollapsed ? "collapsed" : ""}`}
        >
        <button
          className="feedbackSheetTab"
          onPointerDown={beginSheetDrag}
          onPointerMove={moveSheetDrag}
          onPointerUp={endSheetDrag}
          onPointerCancel={cancelSheetDrag}
          aria-expanded={sheetOffset < getSheetMaxOffset() - 12}
        >
          <span />
        </button>

        <section className="drawerPanel feedbackPanel">
            {activeFeedback ? (
              <>
                {activeFeedback.isStale ? (
                  <div className="feedbackWarning">
                    <ShieldAlert size={16} />
                    <span>This request may no longer match the view I asked about. Open the latest request from the bell if this looks off.</span>
                  </div>
                ) : null}
                {editMessage ? (
                  <div className={`editModeNotice ${editStatus}`}>
                    <Edit3 size={15} />
                    <span>{editMessage}{editStatus === "active" ? ". Click text in the page above and type to change it." : ""}</span>
                  </div>
                ) : null}
                {feedbackError ? <div className="feedbackError">{feedbackError}</div> : null}
                {activeFeedback.feedbackSurface ? (
                  <FeedbackSurfaceFrame
                    request={activeFeedback}
                    onCapture={() => void captureFeedback()}
                    onSubmit={(payload) => void respondToFeedback(payload.kind, payload.text, payload.choice, payload.data)}
                  />
                ) : (
                  <>
                    <div className="feedbackHeader">
                      <div>
                        <h2 className="feedbackPrompt">{activeFeedback.prompt}</h2>
                        {activeFeedback.context ? <p>{activeFeedback.context}</p> : null}
                      </div>
                      <button className="viewerIconButton" onClick={() => void captureFeedback()} title="Capture screenshots">
                        <Monitor size={17} />
                      </button>
                    </div>
                    {activeFeedback.choices.length ? (
                      <div className="choiceGrid">
                        {activeFeedback.choices.map((choice) => (
                          <button key={choice} onClick={() => chooseFeedback(choice)}>
                            {choice}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className={`feedbackFreeform ${feedbackFocused || feedbackText.trim() ? "active" : ""}`}>
                      <textarea
                        value={feedbackText}
                        onChange={(event) => setFeedbackText(event.target.value)}
                        onFocus={() => setFeedbackFocused(true)}
                        onBlur={() => setFeedbackFocused(false)}
                        placeholder={activeFeedback.choices.length ? "Add detail" : "Type feedback"}
                      />
                      <button onClick={() => void respondToFeedback("note")} disabled={!feedbackText.trim()}>
                        Send
                      </button>
                    </div>
                  </>
                )}
                <div className="artifactStrip">
                  {visibleArtifacts.map((artifact) => (
                    <figure key={artifact.id}>
                      {artifact.url ? (
                        <button className="artifactThumb" onClick={() => setSelectedArtifact(artifact)} title="Open screenshot">
                          <img src={artifact.url} alt={artifact.label} />
                        </button>
                      ) : (
                        <div>No image</div>
                      )}
                      <figcaption>{artifact.label}</figcaption>
                    </figure>
                  ))}
                </div>
              </>
            ) : (
              <div className="feedbackEmpty">
                No feedback requests
              </div>
            )}
          </section>
      </aside>
      {selectedArtifact?.url ? (
        <div className="artifactLightbox" role="dialog" aria-modal="true" aria-label={selectedArtifact.label}>
          <button className="artifactLightboxClose" onClick={() => setSelectedArtifact(null)} title="Close screenshot">
            Close
          </button>
          <img src={selectedArtifact.url} alt={selectedArtifact.label} />
          <span>{selectedArtifact.label}</span>
        </div>
      ) : null}
    </main>
  );
}

interface TargetEditMessage {
  type: "prtl.target.edit";
  targetId: string;
  selector: string;
  tagName: string;
  before: string;
  after: string;
}

function normalizeTargetEditMessage(value: unknown): TargetEditMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<TargetEditMessage>;
  if (message.type !== "prtl.target.edit") return null;
  if (typeof message.targetId !== "string" || typeof message.after !== "string") return null;
  return {
    type: "prtl.target.edit",
    targetId: message.targetId,
    selector: typeof message.selector === "string" ? message.selector : "",
    tagName: typeof message.tagName === "string" ? message.tagName : "unknown",
    before: typeof message.before === "string" ? message.before : "",
    after: message.after
  };
}

function installEditableTargetBridge(targetWindow: Window | null, doc: Document): void {
  if (!targetWindow || !doc.body) throw new Error("Target frame is not ready");
  const root = doc.documentElement;
  if (root.dataset.prtlEditableInstalled === "1") return;
  root.dataset.prtlEditableInstalled = "1";
  const script = doc.createElement("script");
  script.id = "prtl-editable-script";
  script.textContent = `(${editableTargetScript.toString()})();`;
  (doc.body ?? doc.documentElement).appendChild(script);
}

function editableTargetScript() {
  const editableWindow = window as Window & { __prtlEditableInstalled?: boolean };
  if (editableWindow.__prtlEditableInstalled) return;
  editableWindow.__prtlEditableInstalled = true;

  const style = document.createElement("style");
  style.id = "prtl-editable-style";
  style.textContent = `
    [data-prtl-edit-id] {
      outline: 1px dashed rgba(79, 140, 255, 0.48);
      outline-offset: 2px;
      cursor: text !important;
    }
    [data-prtl-edit-id]:focus {
      outline: 2px solid rgba(79, 140, 255, 0.92);
      background-color: rgba(79, 140, 255, 0.08);
    }
  `;
  document.head?.appendChild(style);

  const timers = new Map<string, number>();
  const selector = [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "li", "blockquote", "figcaption",
    "button", "label", "summary",
    "td", "th", "span", "strong", "em", "small", "a"
  ].join(",");

  Array.from(document.body.querySelectorAll(selector)).forEach((element, index) => {
    const editable = element as HTMLElement;
    if (editable.closest("script, style, svg, canvas, input, textarea, select")) return;
    const text = normalizeEditText(editable.textContent ?? "");
    if (!text) return;
    editable.dataset.prtlEditId ||= `edit-${index}`;
    editable.dataset.prtlOriginal ??= text;
    editable.setAttribute("contenteditable", "plaintext-only");
    editable.setAttribute("spellcheck", "false");
  });

  function editableFromEvent(event: Event): HTMLElement | null {
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    return (typeof target?.closest === "function" ? target.closest("[data-prtl-edit-id]") : null) as HTMLElement | null;
  }

  function flush(element: HTMLElement): void {
    const targetId = element.dataset.prtlEditId ?? "unknown";
    const before = element.dataset.prtlOriginal ?? "";
    const after = normalizeEditText(element.textContent ?? "");
    if (before === after) return;
    window.parent.postMessage({
      type: "prtl.target.edit",
      targetId,
      selector: targetSelector(element),
      tagName: element.tagName.toLowerCase(),
      before,
      after
    }, "*");
    element.dataset.prtlOriginal = after;
  }

  function scheduleFlush(element: HTMLElement): void {
    const targetId = element.dataset.prtlEditId ?? "unknown";
    const existing = timers.get(targetId);
    if (existing) window.clearTimeout(existing);
    timers.set(targetId, window.setTimeout(() => flush(element), 350));
  }

  document.addEventListener("click", (event) => {
    const element = editableFromEvent(event);
    if (!element) return;
    if (element.matches("a, button")) {
      event.preventDefault();
      event.stopPropagation();
      element.focus();
    }
  }, true);

  document.addEventListener("input", (event) => {
    const element = editableFromEvent(event);
    if (element) scheduleFlush(element);
  }, true);

  document.addEventListener("blur", (event) => {
    const element = editableFromEvent(event);
    if (element) flush(element);
  }, true);

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const node = mutation.target as {
        closest?: (selector: string) => Element | null;
        parentElement?: { closest?: (selector: string) => Element | null } | null;
      };
      const element =
        typeof node.closest === "function"
          ? node.closest("[data-prtl-edit-id]")
          : node.parentElement && typeof node.parentElement.closest === "function"
            ? node.parentElement.closest("[data-prtl-edit-id]")
            : null;
      if (element) scheduleFlush(element as HTMLElement);
    }
  }).observe(document.body, { childList: true, characterData: true, subtree: true });

  function normalizeEditText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function targetSelector(element: HTMLElement): string {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== current.ownerDocument.body && parts.length < 5) {
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      const tagName = current.tagName;
      const siblings = Array.from(parent.children) as Element[];
      const matching = siblings.filter((item) => item.tagName === tagName);
      const index = matching.indexOf(current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}${matching.length > 1 ? `:nth-of-type(${index})` : ""}`);
      current = parent;
    }
    return parts.join(" > ");
  }
}

interface FeedbackSurfaceSubmitPayload {
  kind: FeedbackResponseKind;
  text: string;
  choice?: string;
  data?: Record<string, unknown> | null;
}

interface FeedbackSurfaceFrameProps {
  request: FeedbackRequest;
  onCapture: () => void;
  onSubmit: (payload: FeedbackSurfaceSubmitPayload) => void;
}

function FeedbackSurfaceFrame({ request, onCapture, onSubmit }: FeedbackSurfaceFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(280);
  const [ready, setReady] = useState(false);
  const surface = request.feedbackSurface;

  useEffect(() => {
    setReady(false);
    setHeight(280);
  }, [request.id, surface?.html]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return;
      const message = normalizeFeedbackSurfaceMessage(event.data);
      if (!message) return;
      if (message.type === "prtl.feedback.ready") {
        setReady(true);
        if (message.height) setHeight(clampFeedbackSurfaceHeight(message.height));
        return;
      }
      if (message.type === "prtl.feedback.resize") {
        if (message.height) setHeight(clampFeedbackSurfaceHeight(message.height));
        return;
      }
      if (message.type === "prtl.feedback.capture") {
        onCapture();
        return;
      }
      if (message.type === "prtl.feedback.submit") {
        onSubmit({
          kind: normalizeFeedbackKind(message.kind),
          text: message.text || message.choice || "Feedback submitted",
          choice: message.choice || undefined,
          data: normalizeSurfaceData(message.data)
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onCapture, onSubmit]);

  if (!surface) return null;

  return (
    <div className={`feedbackSurface ${ready ? "ready" : ""}`}>
      <iframe
        ref={frameRef}
        title={surface.title ?? request.prompt}
        srcDoc={withPrtlFeedbackBridge(surface.html)}
        sandbox="allow-scripts allow-forms"
        style={{ height }}
      />
    </div>
  );
}

function withPrtlFeedbackBridge(html: string): string {
  const bridge = `<script id="prtl-feedback-bridge">
(() => {
  if (window.prtl && window.prtl.feedback) return;
  const send = (message) => window.parent.postMessage(message, "*");
  window.prtl = Object.assign(window.prtl || {}, {
    feedback: {
      ready: (detail = {}) => send({ type: "prtl.feedback.ready", ...detail }),
      resize: (height) => send({ type: "prtl.feedback.resize", height }),
      capture: () => send({ type: "prtl.feedback.capture" }),
      submit: (payload = {}) => send({ type: "prtl.feedback.submit", ...payload })
    }
  });
})();
</script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b([^>]*)>/i, `<head$1>${bridge}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b([^>]*)>/i, `<html$1>${bridge}`);
  return `${bridge}${html}`;
}

interface FeedbackSurfaceMessage {
  type: string;
  kind?: unknown;
  text?: string;
  choice?: string;
  data?: unknown;
  height?: number;
}

function normalizeFeedbackSurfaceMessage(value: unknown): FeedbackSurfaceMessage | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const message = value as FeedbackSurfaceMessage;
  if (typeof message.type !== "string" || !message.type.startsWith("prtl.feedback.")) return null;
  return message;
}

function normalizeFeedbackKind(value: unknown): FeedbackResponseKind {
  const allowed = new Set<FeedbackResponseKind>(["approve", "reject", "unsure", "note", "broken", "another_version"]);
  return typeof value === "string" && allowed.has(value as FeedbackResponseKind) ? value as FeedbackResponseKind : "note";
}

function normalizeSurfaceData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clampFeedbackSurfaceHeight(value: number): number {
  if (!Number.isFinite(value)) return 280;
  return Math.max(180, Math.min(520, Math.ceil(value)));
}

function getQueryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function appendAppPath(routeUrl: string, appPath: string): string {
  const normalized = appPath.trim() || "/";
  if (normalized === "/") return routeUrl;
  const [pathAndQuery, hash = ""] = normalized.split("#", 2);
  const [pathname, search = ""] = pathAndQuery.split("?", 2);
  const suffix = `${pathname.replace(/^\/+/, "")}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
  return routeUrl.endsWith("/") ? `${routeUrl}${suffix}` : `${routeUrl}/${suffix}`;
}
