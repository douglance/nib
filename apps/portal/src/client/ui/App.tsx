import {
  ArrowUpRight,
  Bell,
  Check,
  ChevronLeft,
  Hand,
  Expand,
  Move,
  Paperclip,
  Pause,
  Play,
  Redo2,
  RefreshCw,
  Square,
  Type,
  Undo2,
  Video,
  VideoOff,
  WifiOff,
  ZoomIn
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, CSSProperties, PointerEvent as ReactPointerEvent, SVGProps } from "react";
import type { RequestRecord } from "../../shared/types";
import { assetUrl, nibFetch, webSocketUrl } from "../native";
import motionContract from "../../../../../design/motion.json";

type ConnectionState = "connecting" | "connected" | "reconnecting";
type ReviewTool = "select" | "pan" | "cursor" | "arrow" | "rectangle" | "text" | "path";
type Decision = "approve" | "reject" | "comment";
type MotionMode = "full" | "reduced" | "off";

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
  timeMs?: number;
}

interface DrawState {
  start: [number, number];
  points: Array<[number, number]>;
}

interface RequestSocketMessage {
  type: "ready" | "request";
  action?: "created" | "published" | "updated" | "responded";
  request?: RequestRecord;
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
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(webSocketUrl("/api/requests/socket"));
      socket.onopen = () => {
        reconnectAttempt = 0;
        setConnection("connected");
        void loadRequests();
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as RequestSocketMessage;
          if (message.type === "request" && message.request) {
            setRequests((current) => upsertRequest(current, message.request!));
          }
        } catch {
          // Ignore malformed frames and keep the live connection usable.
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        setConnection("reconnecting");
        const delay = Math.min(1_000 * (2 ** reconnectAttempt), 8_000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay + Math.random() * 250);
      };
    };

    connect();
    const onFocus = () => void loadRequests();
    const onPopState = () => setSelectedId(requestIdFromPath());
    window.addEventListener("focus", onFocus);
    window.addEventListener("popstate", onPopState);
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close(1000, "view closed");
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
        <div className="reconnectBanner"><WifiOff size={17} /> Reconnecting to Nib. Reviews will refresh automatically.</div>
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
            <p>{loading ? "Connecting to Nib..." : "New visual reviews from any connected machine will appear here."}</p>
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
                <span className="completedIdentity">
                  <span>{request.title}</span>
                  {request.responses[0]?.device?.name
                    ? <small>Answered on {request.responses[0].device.name}</small>
                    : null}
                </span>
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
    const deviceName = request.responses[0]?.device?.name;
    return (
      <main className="reviewShell">
        <ReviewHeader request={request} connection={connection} onBack={onBack} />
        <div className="reviewLoading">
          <h1>Review already submitted</h1>
          <p>{deviceName ? `Answered on ${deviceName}.` : "The first response has already been sent."}</p>
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
  const subject = reviewSubject(request);
  const video = subject?.primary.kind === "video"
    ? request.attachments.find((attachment) => attachment.id === subject.primary.attachmentId)
      ?? request.attachments.find((attachment) => attachment.contentType === "video/mp4")
    : undefined;
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
  const [motionMode] = useState<MotionMode>(configuredMotionMode);
  const [exiting, setExiting] = useState(false);
  const [draw, setDraw] = useState<DrawState | null>(null);
  const [imageSize, setImageSize] = useState({
    width: subject?.primary.width ?? canvasCrop?.width ?? 1,
    height: subject?.primary.height ?? canvasCrop?.height ?? 1
  });
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(subject?.primary.durationMs ?? 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [replyMedia, setReplyMedia] = useState<File | null>(null);
  const [replyUploaded, setReplyUploaded] = useState(false);
  const [recordingReply, setRecordingReply] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const replyRecorder = useRef<MediaRecorder | null>(null);
  const replyStream = useRef<MediaStream | null>(null);
  const replyChunks = useRef<Blob[]>([]);
  const panStart = useRef<{ pointer: [number, number]; offset: { x: number; y: number } } | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const update = () => setMobileLayout(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    setImageSize({
      width: subject?.primary.width ?? canvasCrop?.width ?? 1,
      height: subject?.primary.height ?? canvasCrop?.height ?? 1
    });
  }, [canvasCrop?.height, canvasCrop?.width, subject?.primary.height, subject?.primary.width]);

  useEffect(() => {
    if (!video) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === " ") {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekVideo(Math.max(0, currentTimeMs - 1_000));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekVideo(Math.min(durationMs, currentTimeMs + 1_000));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentTimeMs, durationMs, isPlaying, video]);

  useEffect(() => () => {
    replyRecorder.current?.stop();
    replyStream.current?.getTracks().forEach((track) => track.stop());
  }, []);

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
    if (video && isPlaying) pauseVideo();
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
    setAnnotations((current) => [...current, video ? { ...annotation, timeMs: Math.round(currentTimeMs) } : annotation]);
    setRedo([]);
  }

  function pauseVideo() {
    videoRef.current?.pause();
    setIsPlaying(false);
  }

  async function togglePlayback() {
    const player = videoRef.current;
    if (!player) return;
    if (player.paused) {
      await player.play();
      setIsPlaying(true);
    } else {
      pauseVideo();
    }
  }

  function seekVideo(timeMs: number) {
    const player = videoRef.current;
    if (!player) return;
    pauseVideo();
    player.currentTime = Math.max(0, Math.min(durationMs, timeMs)) / 1_000;
    setCurrentTimeMs(player.currentTime * 1_000);
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
      if (replyMedia && !replyUploaded) await uploadReplyMedia(replyMedia);
      await playExit();
      const response = await nibFetch(`/api/requests/${encodeURIComponent(request.id)}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision,
          comment: comment.trim() || undefined,
          annotations,
          ...(replyMedia ? {
            transcript: {
              status: "unavailable",
              source: "none",
              text: "",
              segments: [],
              error: "Device transcription was unavailable; origin-Mac fallback may retry"
            }
          } : {})
        })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: `Response failed: ${response.status}` })) as { error?: string };
        throw new Error(payload.error || `Response failed: ${response.status}`);
      }
      onSubmitted(await response.json() as RequestRecord);
    } catch (responseError) {
      setSubmitError(responseError instanceof Error ? responseError.message : "Response failed");
      setExiting(false);
    } finally {
      setSubmitting(null);
    }
  }

  async function uploadReplyMedia(file: File) {
    if (file.type !== "video/mp4") throw new Error("Reply video must be MP4/H.264");
    const response = await nibFetch(`/api/requests/${encodeURIComponent(request.id)}/response-attachments`, {
      method: "POST",
      headers: {
        "content-type": "video/mp4",
        "x-nib-filename": file.name
      },
      body: file
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: `Upload failed: ${response.status}` })) as { error?: string };
      throw new Error(payload.error || `Upload failed: ${response.status}`);
    }
    setReplyUploaded(true);
  }

  async function startReplyRecording() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported("video/mp4")) {
      setSubmitError("This browser cannot record H.264 MP4. Attach an MP4 reply instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "video/mp4" });
      replyChunks.current = [];
      replyStream.current = stream;
      replyRecorder.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) replyChunks.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(replyChunks.current, { type: "video/mp4" });
        setReplyMedia(new File([blob], `reply-${Date.now()}.mp4`, { type: "video/mp4" }));
        setReplyUploaded(false);
        replyStream.current?.getTracks().forEach((track) => track.stop());
        replyStream.current = null;
        replyRecorder.current = null;
        setRecordingReply(false);
      };
      recorder.start(500);
      setRecordingReply(true);
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Reply recording failed");
    }
  }

  function stopReplyRecording() {
    if (replyRecorder.current?.state !== "inactive") replyRecorder.current?.stop();
  }

  async function playExit() {
    setExiting(true);
    const duration = motionMode === "full"
      ? motionContract.full.exit.duration_ms
      : motionMode === "reduced" ? motionContract.reduced.fade_ms : 0;
    if (duration > 0) await new Promise((resolve) => window.setTimeout(resolve, duration));
  }

  const draft = draw ? draftAnnotation(tool, draw, color) : null;
  const visibleAnnotations = video
    ? annotations.filter((annotation) => !isPlaying && Math.abs((annotation.timeMs ?? -1) - currentTimeMs) <= 50)
    : annotations;
  const overlayAnnotations = draft ? [...visibleAnnotations, draft] : visibleAnnotations;
  const timelineMarkers = video
    ? annotations.filter((annotation) => typeof annotation.timeMs === "number")
    : [];

  return (
    <main
      className={`reviewShell activeReview motion-${motionMode}${exiting ? " is-exiting" : ""}`}
      data-testid="active-review"
      style={{
        "--motion-materialize": `${motionContract.full.enter.materialize_ms}ms`,
        "--motion-settle": `${motionContract.full.enter.settle_ms}ms`,
        "--motion-exit": `${motionContract.full.exit.duration_ms}ms`,
        "--motion-reduced": `${motionContract.reduced.fade_ms}ms`
      } as CSSProperties}
    >
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
              {video ? (
                <video
                  ref={videoRef}
                  className="videoSource"
                  src={assetUrl(video.url) ?? undefined}
                  poster={preview ? assetUrl(preview.url) ?? undefined : undefined}
                  playsInline
                  preload="metadata"
                  aria-label={request.title}
                  onLoadedMetadata={(event) => {
                    setImageSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
                    setDurationMs(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration * 1_000 : durationMs);
                  }}
                  onTimeUpdate={(event) => setCurrentTimeMs(event.currentTarget.currentTime * 1_000)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                />
              ) : preview && canvasCrop ? (
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
              <AnnotationOverlay annotations={overlayAnnotations} size={imageSize} />
            </div>
          </div>
          {video ? (
            <div className="videoTimeline" aria-label="Video timeline">
              <button className="playbackButton" onClick={() => void togglePlayback()} aria-label={isPlaying ? "Pause video" : "Play video"}>
                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <span className="videoTime">{formatVideoTime(currentTimeMs)}</span>
              <div className="timelineTrack">
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, durationMs)}
                  step={10}
                  value={Math.min(currentTimeMs, Math.max(1, durationMs))}
                  onChange={(event) => seekVideo(Number(event.currentTarget.value))}
                  aria-label="Video position"
                />
                {timelineMarkers.map((annotation, index) => (
                  <button
                    key={annotation.id}
                    className="timelineMarker"
                    style={{ left: `${durationMs ? ((annotation.timeMs ?? 0) / durationMs) * 100 : 0}%` }}
                    onClick={() => seekVideo(annotation.timeMs ?? 0)}
                    aria-label={`Annotation ${index + 1} at ${formatVideoTime(annotation.timeMs ?? 0)}`}
                  />
                ))}
              </div>
              <span className="videoTime">{formatVideoTime(durationMs)}</span>
            </div>
          ) : null}
        </section>
        <aside className="decisionPanel">
          <h2>{request.prompt}</h2>
          <div className="replyMediaControls">
            <label className="replyMediaButton">
              <Paperclip size={17} />
              <span>Attach MP4</span>
              <input
                type="file"
                accept="video/mp4,.mp4"
                onChange={(event) => {
                  setReplyMedia(event.currentTarget.files?.[0] ?? null);
                  setReplyUploaded(false);
                }}
              />
            </label>
            <button
              className={`replyMediaButton${recordingReply ? " recording" : ""}`}
              onClick={recordingReply ? stopReplyRecording : () => void startReplyRecording()}
            >
              {recordingReply ? <VideoOff size={17} /> : <Video size={17} />}
              {recordingReply ? "Stop" : "Record reply"}
            </button>
          </div>
          {replyMedia ? <p className="replyMediaStatus">{replyUploaded ? "Reply video uploaded" : replyMedia.name}</p> : null}
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment..." />
          {submitError ? <p className="submitError">{submitError}</p> : null}
          <button className="decisionButton approve" disabled={Boolean(submitting)} onClick={() => void submit("approve")}>{submitting === "approve" ? "Sending..." : "Approve"}</button>
          <button className="decisionButton reject" disabled={Boolean(submitting)} onClick={() => void submit("reject")}>{submitting === "reject" ? "Sending..." : "Reject"}</button>
          <button className="decisionButton comment" disabled={Boolean(submitting) || (!comment.trim() && !replyMedia)} onClick={() => void submit("comment")}>{submitting === "comment" ? "Sending..." : "Comment"}</button>
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
  return <span className={`connectionPill ${state}`}><span />{state === "connected" ? "Connected to Nib" : state === "reconnecting" ? "Reconnecting" : "Connecting"}</span>;
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
  return <span className={`responseBadge ${rejected ? "rejected" : "approved"}`}>{rejected ? "Rejected" : decision === "comment" ? "Commented" : "Approved"}</span>;
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

function configuredMotionMode(): MotionMode {
  const override = window.localStorage.getItem("nib.motion");
  if (override === "full" || override === "reduced" || override === "off") return override;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full";
}

function thumbnailCrop(value: unknown): { x: number; y: number; width: number; height: number; sourceWidth: number; sourceHeight: number } | null {
  if (!value || typeof value !== "object") return null;
  const crop = value as Record<string, unknown>;
  const values = [crop.x, crop.y, crop.width, crop.height, crop.sourceWidth, crop.sourceHeight];
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return crop as { x: number; y: number; width: number; height: number; sourceWidth: number; sourceHeight: number };
}

function reviewSubject(request: RequestRecord): {
  primary: {
    attachmentId: string;
    kind: "image" | "video";
    width: number;
    height: number;
    durationMs?: number;
  };
} | null {
  const subject = request.metadata.subject;
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return null;
  const primary = (subject as Record<string, unknown>).primary;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return null;
  const value = primary as Record<string, unknown>;
  if (
    typeof value.attachmentId !== "string"
    || (value.kind !== "image" && value.kind !== "video")
    || typeof value.width !== "number"
    || typeof value.height !== "number"
  ) return null;
  return {
    primary: {
      attachmentId: value.attachmentId,
      kind: value.kind,
      width: value.width,
      height: value.height,
      ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {})
    }
  };
}

function formatVideoTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
