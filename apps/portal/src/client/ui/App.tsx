import {
  ArrowUpRight,
  Bell,
  Check,
  ChevronLeft,
  Hand,
  Expand,
  Move,
  Redo2,
  RefreshCw,
  Square,
  Type,
  Undo2,
  WifiOff,
  ZoomIn
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, PointerEvent as ReactPointerEvent, SVGProps } from "react";
import type { RequestRecord } from "../../shared/types";
import { apiUrl, assetUrl, nibFetch } from "../native";

type ConnectionState = "connecting" | "connected" | "reconnecting";
type ReviewTool = "select" | "pan" | "cursor" | "arrow" | "rectangle" | "text" | "path";
type Decision = "approve" | "reject" | "comment";

interface ReviewAnnotation {
  id: string;
  type: "arrow" | "rectangle" | "text" | "path";
  color: string;
  start_x?: number;
  start_y?: number;
  end_x?: number;
  end_y?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  content?: string;
  points?: Array<[number, number]>;
  stroke_width?: number;
  head?: string;
  font_size?: number;
  align?: string;
}

interface DrawState {
  start: [number, number];
  points: Array<[number, number]>;
}

export function App() {
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [selectedId, setSelectedId] = useState(() => requestIdFromPath());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notificationsReady, setNotificationsReady] = useState(false);

  const pending = useMemo(() => requests.filter(isPending).sort(byNewest), [requests]);
  const completed = useMemo(() => requests.filter(isCompleted).sort(byOldest).slice(-4), [requests]);
  const selected = requests.find((request) => request.id === selectedId) ?? null;

  async function loadRequests() {
    try {
      const response = await nibFetch("/api/requests");
      if (!response.ok) throw new Error(`Inbox failed: ${response.status}`);
      const payload = await response.json() as RequestRecord[];
      setRequests(payload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Inbox unavailable");
      setConnection("reconnecting");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRequests();
    void notificationStatus().then(setNotificationsReady);
    const events = new EventSource(apiUrl("/api/requests/events"));
    events.onopen = () => setConnection("connected");
    events.onerror = () => setConnection("reconnecting");
    events.addEventListener("request", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { request: RequestRecord };
      setRequests((current) => upsertRequest(current, payload.request));
    });
    const onFocus = () => void loadRequests();
    const onPopState = () => setSelectedId(requestIdFromPath());
    window.addEventListener("focus", onFocus);
    window.addEventListener("popstate", onPopState);
    return () => {
      events.close();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    if (!selectedId || selected || loading) return;
    void nibFetch(`/api/requests/${encodeURIComponent(selectedId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "Review not found" : `Review failed: ${response.status}`);
        const request = await response.json() as RequestRecord;
        setRequests((current) => upsertRequest(current, request));
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Review unavailable"));
  }, [loading, selected, selectedId]);

  function openRequest(request: RequestRecord) {
    if (request.kind !== "visual-review") {
      window.location.assign(`/r/${encodeURIComponent(request.id)}`);
      return;
    }
    window.history.pushState(null, "", `/r/${encodeURIComponent(request.id)}`);
    setSelectedId(request.id);
  }

  function showInbox(replace = false) {
    window.history[replace ? "replaceState" : "pushState"](null, "", "/");
    setSelectedId(null);
  }

  function handleSubmitted(updated: RequestRecord) {
    const nextRequests = upsertRequest(requests, updated);
    setRequests(nextRequests);
    const next = nextRequests.filter((request) => request.id !== updated.id).filter(isPending).sort(byNewest)[0];
    if (next) {
      window.history.replaceState(null, "", `/r/${encodeURIComponent(next.id)}`);
      setSelectedId(next.id);
    } else {
      showInbox(true);
    }
  }

  if (selectedId) {
    return (
      <ReviewScreen
        request={selected}
        connection={connection}
        error={error}
        onBack={() => showInbox()}
        onRefresh={() => void loadRequests()}
        onSubmitted={handleSubmitted}
      />
    );
  }

  return (
    <InboxScreen
      pending={pending}
      completed={completed}
      connection={connection}
      loading={loading}
      error={error}
      notificationsReady={notificationsReady}
      onEnableNotifications={() => void enableNotifications().then(setNotificationsReady).catch((setupError) => {
        setError(setupError instanceof Error ? setupError.message : "Notification setup failed");
      })}
      onOpen={openRequest}
      onRefresh={() => void loadRequests()}
    />
  );
}

function InboxScreen({
  pending,
  completed,
  connection,
  loading,
  error,
  notificationsReady,
  onEnableNotifications,
  onOpen,
  onRefresh
}: {
  pending: RequestRecord[];
  completed: RequestRecord[];
  connection: ConnectionState;
  loading: boolean;
  error: string | null;
  notificationsReady: boolean;
  onEnableNotifications: () => void;
  onOpen: (request: RequestRecord) => void;
  onRefresh: () => void;
}) {
  return (
    <main className="inboxShell" data-testid="inbox">
      <header className="inboxHeader">
        <NibMark />
        <div className="inboxActions">
          <ConnectionPill state={connection} />
          <span className="badgeSeparator" aria-hidden="true">•</span>
          <span className="pendingCount">{pending.length} Pending</span>
          <button className="textButton" onClick={onRefresh} aria-label="Refresh inbox">
            <RefreshCw size={18} className={loading ? "spinning" : ""} />
            <span>Refresh</span>
          </button>
          <button className={`iconButton ${notificationsReady ? "active" : ""}`} onClick={onEnableNotifications} aria-label="Enable notifications">
            <Bell size={19} />
          </button>
        </div>
      </header>

      {connection === "reconnecting" ? (
        <div className="reconnectBanner"><WifiOff size={17} /> Reconnecting to Dave. Reviews will refresh automatically.</div>
      ) : null}
      {error ? <div className="errorBanner">{error}</div> : null}

      <section className="queueSection">
        <p className="eyebrow">Prioritized visual review queue</p>
        {pending.length ? (
          <div className="requestQueue">
            {pending.map((request, index) => (
              <button key={request.id} className={`requestRow ${index === 0 ? "priority" : ""}`} onClick={() => onOpen(request)}>
                <RequestThumbnail request={request} />
                <span className="requestIdentity">
                  <strong>{request.title}</strong>
                  <small>{request.source || "Unknown source"}</small>
                </span>
                <time>{relativeTime(request.createdAt)}</time>
                <span className="statusBadge">{index === 0 ? "Pending Review" : "Awaiting Approval"}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="emptyInbox">
            <span className="emptyCheck"><Check size={28} /></span>
            <h1>{loading ? "Loading reviews" : "Inbox clear"}</h1>
            <p>{loading ? "Connecting to Dave..." : "New visual reviews from any connected machine will appear here."}</p>
          </div>
        )}
      </section>

      {completed.length ? (
        <section className="completedSection">
          <h2>Recent Completed</h2>
          <div className="completedList">
            {completed.map((request) => (
              <div className="completedRow" key={request.id}>
                <Check size={18} />
                <span>{request.title}</span>
                <ResponseBadge request={request} />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function ReviewScreen({
  request,
  connection,
  error,
  onBack,
  onRefresh,
  onSubmitted
}: {
  request: RequestRecord | null;
  connection: ConnectionState;
  error: string | null;
  onBack: () => void;
  onRefresh: () => void;
  onSubmitted: (request: RequestRecord) => void;
}) {
  if (!request) {
    return (
      <main className="reviewShell">
        <ReviewHeader request={null} connection={connection} onBack={onBack} />
        <div className="reviewLoading">
          {error ? <><h1>Review unavailable</h1><p>{error}</p><button className="textButton" onClick={onRefresh}>Try again</button></> : <p>Loading review...</p>}
        </div>
      </main>
    );
  }

  const expired = request.expiresAt ? new Date(request.expiresAt).getTime() <= Date.now() : false;
  if (expired && !request.responses.length) {
    return (
      <main className="reviewShell">
        <ReviewHeader request={request} connection={connection} onBack={onBack} />
        <div className="reviewLoading expiredState">
          <h1>Review expired</h1>
          <p>This request is no longer accepting a response. Ask the originating machine to publish it again.</p>
          <button className="textButton" onClick={onBack}><ChevronLeft size={17} /> Back to inbox</button>
        </div>
      </main>
    );
  }

  if (request.responses.length) {
    return (
      <main className="reviewShell">
        <ReviewHeader request={request} connection={connection} onBack={onBack} />
        <div className="reviewLoading">
          <h1>Review already submitted</h1>
          <p>The first response has already been sent.</p>
          <button className="textButton" onClick={onBack}><ChevronLeft size={17} /> Back to inbox</button>
        </div>
      </main>
    );
  }

  return <ActiveReview key={request.id} request={request} connection={connection} onBack={onBack} onSubmitted={onSubmitted} />;
}

function ActiveReview({ request, connection, onBack, onSubmitted }: {
  request: RequestRecord;
  connection: ConnectionState;
  onBack: () => void;
  onSubmitted: (request: RequestRecord) => void;
}) {
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia("(max-width: 800px)").matches);
  const desktopPreview = request.attachments.find((attachment) => attachment.metadata.role === "preview")
    ?? request.attachments.find((attachment) => attachment.contentType.startsWith("image/"));
  const mobilePreview = request.attachments.find((attachment) => attachment.metadata.role === "preview-mobile");
  const preview = mobileLayout && mobilePreview ? mobilePreview : desktopPreview;
  const canvasCrop = thumbnailCrop(preview?.metadata.canvasCrop);
  const [tool, setTool] = useState<ReviewTool>("select");
  const [annotations, setAnnotations] = useState<ReviewAnnotation[]>([]);
  const [redo, setRedo] = useState<ReviewAnnotation[]>([]);
  const [comment, setComment] = useState("");
  const [color, setColor] = useState("#2376d2");
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draw, setDraw] = useState<DrawState | null>(null);
  const [imageSize, setImageSize] = useState({ width: canvasCrop?.width ?? 1, height: canvasCrop?.height ?? 1 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ pointer: [number, number]; offset: { x: number; y: number } } | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const update = () => setMobileLayout(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    setImageSize({ width: canvasCrop?.width ?? 1, height: canvasCrop?.height ?? 1 });
  }, [canvasCrop?.height, canvasCrop?.width]);

  function imagePoint(event: ReactPointerEvent): [number, number] {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return [0, 0];
    return [
      ((event.clientX - rect.left) / rect.width) * imageSize.width,
      ((event.clientY - rect.top) / rect.height) * imageSize.height
    ];
  }

  function pointerDown(event: ReactPointerEvent) {
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "pan") {
      panStart.current = { pointer: [event.clientX, event.clientY], offset };
      return;
    }
    if (tool === "select" || tool === "cursor") return;
    const point = imagePoint(event);
    if (tool === "text") {
      const content = window.prompt("Text annotation");
      if (content?.trim()) addAnnotation({ id: annotationId(), type: "text", x: point[0], y: point[1], content: content.trim(), color, font_size: 16, align: "left" });
      return;
    }
    setDraw({ start: point, points: [point] });
  }

  function pointerMove(event: ReactPointerEvent) {
    if (tool === "pan" && panStart.current) {
      setOffset({
        x: panStart.current.offset.x + event.clientX - panStart.current.pointer[0],
        y: panStart.current.offset.y + event.clientY - panStart.current.pointer[1]
      });
      return;
    }
    if (!draw) return;
    const point = imagePoint(event);
    setDraw((current) => current ? { ...current, points: tool === "path" ? [...current.points, point] : [current.start, point] } : null);
  }

  function pointerUp(event: ReactPointerEvent) {
    if (tool === "pan") {
      panStart.current = null;
      return;
    }
    if (!draw) return;
    const end = imagePoint(event);
    if (tool === "arrow") {
      addAnnotation({ id: annotationId(), type: "arrow", start_x: draw.start[0], start_y: draw.start[1], end_x: end[0], end_y: end[1], color, stroke_width: 3, head: "end" });
    } else if (tool === "rectangle") {
      addAnnotation(rectangleAnnotation(draw.start, end, color));
    } else if (tool === "path" && draw.points.length > 1) {
      addAnnotation({ id: annotationId(), type: "path", points: draw.points, color, stroke_width: 3 });
    }
    setDraw(null);
  }

  function addAnnotation(annotation: ReviewAnnotation) {
    setAnnotations((current) => [...current, annotation]);
    setRedo([]);
  }

  function undo() {
    setAnnotations((current) => {
      const last = current.at(-1);
      if (last) setRedo((items) => [...items, last]);
      return current.slice(0, -1);
    });
  }

  function redoAnnotation() {
    setRedo((current) => {
      const last = current.at(-1);
      if (last) setAnnotations((items) => [...items, last]);
      return current.slice(0, -1);
    });
  }

  async function submit(decision: Decision) {
    setSubmitting(decision);
    setSubmitError(null);
    try {
      const response = await nibFetch(`/api/requests/${encodeURIComponent(request.id)}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, comment: comment.trim() || undefined, annotations })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: `Response failed: ${response.status}` })) as { error?: string };
        throw new Error(payload.error || `Response failed: ${response.status}`);
      }
      onSubmitted(await response.json() as RequestRecord);
    } catch (responseError) {
      setSubmitError(responseError instanceof Error ? responseError.message : "Response failed");
    } finally {
      setSubmitting(null);
    }
  }

  const draft = draw ? draftAnnotation(tool, draw, color) : null;

  return (
    <main className="reviewShell activeReview" data-testid="active-review">
      <ReviewHeader request={request} connection={connection} onBack={onBack} />
      <div className="reviewLayout">
        <section className="canvasPanel">
          <ReviewToolbar
            tool={tool}
            setTool={setTool}
            color={color}
            setColor={setColor}
            canUndo={annotations.length > 0}
            canRedo={redo.length > 0}
            onUndo={undo}
            onRedo={redoAnnotation}
            onZoom={() => setZoom((value) => value >= 2 ? 1 : value + 0.25)}
            onFullscreen={() => void document.querySelector(".canvasViewport")?.requestFullscreen()}
          />
          <div className="canvasViewport">
            <div
              ref={canvasRef}
              className={`imageCanvas tool-${tool}`}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
            >
              {preview && canvasCrop ? (
                <svg className="canvasSource" viewBox={`${canvasCrop.x} ${canvasCrop.y} ${canvasCrop.width} ${canvasCrop.height}`} preserveAspectRatio="none" aria-label={request.title}>
                  <image href={assetUrl(preview.url) ?? undefined} width={canvasCrop.sourceWidth} height={canvasCrop.sourceHeight} />
                </svg>
              ) : preview ? (
                <img
                  src={assetUrl(preview.url) ?? undefined}
                  alt={request.title}
                  draggable={false}
                  onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                />
              ) : <div className="missingPreview">Preview unavailable</div>}
              <AnnotationOverlay annotations={draft ? [...annotations, draft] : annotations} size={imageSize} />
            </div>
          </div>
        </section>
        <aside className="decisionPanel">
          <h2>{request.prompt}</h2>
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment..." />
          {submitError ? <p className="submitError">{submitError}</p> : null}
          <button className="decisionButton approve" disabled={Boolean(submitting)} onClick={() => void submit("approve")}>{submitting === "approve" ? "Sending..." : "Approve"}</button>
          <button className="decisionButton reject" disabled={Boolean(submitting)} onClick={() => void submit("reject")}>{submitting === "reject" ? "Sending..." : "Request changes"}</button>
          <button className="decisionButton comment" disabled={Boolean(submitting) || !comment.trim()} onClick={() => void submit("comment")}>{submitting === "comment" ? "Sending..." : "Send comment"}</button>
        </aside>
      </div>
    </main>
  );
}

function ReviewHeader({ request, connection, onBack }: { request: RequestRecord | null; connection: ConnectionState; onBack: () => void }) {
  return (
    <header className="reviewHeader">
      <button className="backButton" onClick={onBack}><ChevronLeft size={18} /> <span>Back to inbox</span></button>
      <NibMark />
      <div className="reviewIdentity">
        <strong>{request?.title ?? "Visual review"}</strong>
        <small>{request?.source ?? ""}</small>
      </div>
      <div className="reviewConnection"><ConnectionPill state={connection} />{request ? <time>{relativeTime(request.createdAt)}</time> : null}</div>
    </header>
  );
}

function ReviewToolbar({ tool, setTool, color, setColor, canUndo, canRedo, onUndo, onRedo, onZoom, onFullscreen }: {
  tool: ReviewTool;
  setTool: (tool: ReviewTool) => void;
  color: string;
  setColor: (color: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onZoom: () => void;
  onFullscreen: () => void;
}) {
  const tools: Array<[ReviewTool, ComponentType<{ className?: string }>, string, ComponentType<{ className?: string }> | undefined]> = [
    ["select", CursorIcon, "Select", MobileCursorIcon],
    ["pan", Move, "Pan", Hand],
    ["cursor", FilledCursorIcon, "Pointer", undefined],
    ["arrow", ArrowUpRight, "Arrow", undefined],
    ["rectangle", Square, "Rectangle", undefined],
    ["text", Type, "Text", MobileTextIcon],
    ["path", FreehandIcon, "Freehand", FreehandIcon]
  ];
  return (
    <div className="reviewToolbar" aria-label="Annotation tools">
      {tools.map(([id, Icon, label, MobileIcon]) => (
        <button key={id} className={tool === id ? "active" : ""} onClick={() => setTool(id)} title={label} aria-label={label}>
          <Icon className={MobileIcon ? "desktopToolIcon" : undefined} />
          {MobileIcon ? <MobileIcon className="mobileToolIcon" /> : null}
        </button>
      ))}
      <span className="toolbarDivider" />
      <button onClick={onUndo} aria-disabled={!canUndo} title="Undo" aria-label="Undo"><Undo2 /></button>
      <button onClick={onRedo} disabled={!canRedo} title="Redo" aria-label="Redo"><Redo2 /></button>
      <span className="toolbarDivider" />
      <button onClick={onZoom} title="Zoom" aria-label="Zoom"><ZoomIn /></button>
      <button onClick={onFullscreen} title="Fullscreen" aria-label="Fullscreen"><Expand /></button>
      <label className="colorButton" title={`Color: ${color}`}><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><span /></label>
    </div>
  );
}

function FreehandIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 13c-3-3-1-8 4-12 5-3 8-1 6 4-2 6-8 10-10 6m10-6c-3 7-8 12-10 18m7-10c3-4 6-2 3 5-2 5 1 7 3 2l3-5" />
    </svg>
  );
}

function MobileCursorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 2.5l14.5 13-8 .9L6.5 22z" fill="#f8f6ef" />
    </svg>
  );
}

function MobileTextIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props}>
      <text x="3" y="22" fill="currentColor" stroke="none" fontFamily="Times New Roman, serif" fontSize="25">T</text>
    </svg>
  );
}

function CursorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4.5 2.5v18l5.2-5.1 3.8 6.6 3-1.7-3.8-6.6H20z" fill="#f8f6ef" />
    </svg>
  );
}

function FilledCursorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props}>
      <path d="M5 3v17l5-5 3.6 6.3 3-1.7-3.6-6.3h7z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function AnnotationOverlay({ annotations, size }: { annotations: ReviewAnnotation[]; size: { width: number; height: number } }) {
  return (
    <svg className="annotationOverlay" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
      <defs><marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" /></marker></defs>
      {annotations.map((annotation) => {
        if (annotation.type === "arrow") return <line key={annotation.id} x1={annotation.start_x} y1={annotation.start_y} x2={annotation.end_x} y2={annotation.end_y} stroke={annotation.color} strokeWidth={annotation.stroke_width ?? 3} markerEnd="url(#arrowhead)" />;
        if (annotation.type === "rectangle") return <rect key={annotation.id} x={annotation.x} y={annotation.y} width={annotation.width} height={annotation.height} fill="transparent" stroke={annotation.color} strokeWidth={annotation.stroke_width ?? 3} />;
        if (annotation.type === "text") return <text key={annotation.id} x={annotation.x} y={annotation.y} fill={annotation.color} fontSize={annotation.font_size ?? 16} fontFamily="system-ui, sans-serif">{annotation.content}</text>;
        return <polyline key={annotation.id} points={annotation.points?.map((point) => point.join(",")).join(" ")} fill="none" stroke={annotation.color} strokeWidth={annotation.stroke_width ?? 3} strokeLinecap="round" strokeLinejoin="round" />;
      })}
    </svg>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  return <span className={`connectionPill ${state}`}><span />{state === "connected" ? "Connected to Dave" : state === "reconnecting" ? "Reconnecting" : "Connecting"}</span>;
}

function NibMark() {
  return <div className="nibMark" aria-label="Nib">nib</div>;
}

function RequestThumbnail({ request }: { request: RequestRecord }) {
  const preview = request.attachments.find((attachment) => attachment.metadata.role === "preview")
    ?? request.attachments.find((attachment) => attachment.contentType.startsWith("image/"));
  const crop = thumbnailCrop(preview?.metadata.thumbnailCrop);
  const source = preview ? assetUrl(preview.url) ?? undefined : undefined;
  return (
    <span className="requestThumbnail">
      {source && crop ? (
        <svg viewBox={`${crop.x} ${crop.y} ${crop.width} ${crop.height}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <image href={source} width={crop.sourceWidth} height={crop.sourceHeight} />
        </svg>
      ) : source ? <img src={source} alt="" /> : <Move size={24} />}
    </span>
  );
}

function ResponseBadge({ request }: { request: RequestRecord }) {
  const decision = request.responses[0]?.data?.decision ?? request.responses[0]?.choice ?? "Completed";
  const rejected = decision === "reject";
  return <span className={`responseBadge ${rejected ? "rejected" : "approved"}`}>{rejected ? "Changes Requested" : decision === "comment" ? "Commented" : "Approved"}</span>;
}

function rectangleAnnotation(start: [number, number], end: [number, number], color: string): ReviewAnnotation {
  return {
    id: annotationId(),
    type: "rectangle",
    x: Math.min(start[0], end[0]),
    y: Math.min(start[1], end[1]),
    width: Math.abs(end[0] - start[0]),
    height: Math.abs(end[1] - start[1]),
    color,
    stroke_width: 3
  };
}

function draftAnnotation(tool: ReviewTool, draw: DrawState, color: string): ReviewAnnotation | null {
  const end = draw.points.at(-1) ?? draw.start;
  if (tool === "arrow") return { id: "draft", type: "arrow", start_x: draw.start[0], start_y: draw.start[1], end_x: end[0], end_y: end[1], color, stroke_width: 3, head: "end" };
  if (tool === "rectangle") return { ...rectangleAnnotation(draw.start, end, color), id: "draft" };
  if (tool === "path") return { id: "draft", type: "path", points: draw.points, color, stroke_width: 3 };
  return null;
}

function annotationId(): string {
  return `web-${crypto.randomUUID()}`;
}

function thumbnailCrop(value: unknown): { x: number; y: number; width: number; height: number; sourceWidth: number; sourceHeight: number } | null {
  if (!value || typeof value !== "object") return null;
  const crop = value as Record<string, unknown>;
  const values = [crop.x, crop.y, crop.width, crop.height, crop.sourceWidth, crop.sourceHeight];
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return crop as { x: number; y: number; width: number; height: number; sourceWidth: number; sourceHeight: number };
}

function requestIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/r\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isPending(request: RequestRecord): boolean {
  const expired = request.expiresAt ? new Date(request.expiresAt).getTime() <= Date.now() : false;
  return !expired && ["open", "viewed", "stale"].includes(request.status) && request.responses.length === 0;
}

function isCompleted(request: RequestRecord): boolean {
  return request.responses.length > 0 || ["answered", "acted", "resolved"].includes(request.status);
}

function byNewest(a: RequestRecord, b: RequestRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function byOldest(a: RequestRecord, b: RequestRecord): number {
  return a.updatedAt.localeCompare(b.updatedAt);
}

function upsertRequest(requests: RequestRecord[], request: RequestRecord): RequestRecord[] {
  const found = requests.some((item) => item.id === request.id);
  return found ? requests.map((item) => item.id === request.id ? request : item) : [request, ...requests];
}

function relativeTime(timestamp: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function notificationStatus(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  const registration = await navigator.serviceWorker.ready;
  return Boolean(await registration.pushManager.getSubscription());
}

async function enableNotifications(): Promise<boolean> {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Notifications are not available in this browser.");
  }
  if (await Notification.requestPermission() !== "granted") throw new Error("Notifications were not enabled.");
  const [{ publicKey }, registration] = await Promise.all([
    nibFetch("/api/notifications/vapid-public-key").then((response) => response.json() as Promise<{ publicKey: string }>),
    navigator.serviceWorker.ready
  ]);
  const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(publicKey)
  });
  const response = await nibFetch("/api/notifications/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() })
  });
  if (!response.ok) throw new Error(`Notification setup failed: ${response.status}`);
  return true;
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}
