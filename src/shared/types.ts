export type ViewportKey = "phone" | "tablet" | "desktop";

export type ProjectStatus = "online" | "offline";

export type ProjectTargetKind = "local-app" | "website" | "html-artifact" | "builtin";

export type HtmlArtifactKind = "plan" | "review" | "explainer" | "report" | "prototype" | "editor" | "deck" | (string & {});

export type RouteMode = "direct" | "pathProxy" | "hostProxy";

export type CompatibilityLevel = "excellent" | "good" | "limited" | "broken";

export type CompatibilityCheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface RouteInfo {
  mode: RouteMode;
  url: string;
  available: boolean;
  label: string;
  statusCode: number | null;
  message: string | null;
}

export interface CompatibilityCheck {
  id: string;
  label: string;
  status: CompatibilityCheckStatus;
  message: string;
}

export interface CompatibilityInfo {
  level: CompatibilityLevel;
  checks: CompatibilityCheck[];
  updatedAt: string;
}

export interface ScreenshotInfo {
  viewport: ViewportKey;
  url: string | null;
  capturedAt: string | null;
  error: string | null;
  width: number;
  height: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  targetKind: ProjectTargetKind;
  processId?: number;
  killable?: boolean;
  port: number;
  host: string;
  sourcePath: string | null;
  command: string | null;
  framework: string | null;
  url?: string;
  artifactPath?: string;
  artifactKind?: HtmlArtifactKind;
  status: ProjectStatus;
  statusCode: number | null;
  contentType: string | null;
  openPath: string;
  directUrl: string;
  routes: Partial<Record<RouteMode, RouteInfo>>;
  preferredRoute: RouteMode;
  compatibility: CompatibilityInfo;
  lastSeenAt: string;
  screenshots: Record<ViewportKey, ScreenshotInfo>;
  virtual?: boolean;
}

export interface RegisteredTarget {
  id: string;
  name: string;
  targetKind: "website" | "html-artifact";
  url?: string;
  artifactPath?: string;
  artifactKind?: HtmlArtifactKind;
  sourceFile?: string;
  hash?: string;
  title?: string | null;
  validation?: HtmlValidationResult | null;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HtmlValidationIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface HtmlValidationResult {
  file: string;
  valid: boolean;
  stats: {
    bytes: number;
    title: string | null;
    headings: number;
    buttons: number;
    forms: number;
    scripts: number;
    externalScripts: number;
    externalStyles: number;
    internalAnchors: number;
  };
  issues: HtmlValidationIssue[];
}

export interface HtmlArtifactSummary {
  id: string;
  name: string;
  title: string | null;
  artifactKind?: HtmlArtifactKind;
  artifactPath: string;
  sourceFile?: string;
  hash?: string;
  tags: string[];
  validation: HtmlValidationResult | null;
  createdAt: string;
  updatedAt: string;
  viewerUrl: string;
  artifactUrl: string;
  screenshots: Record<ViewportKey, ScreenshotInfo>;
}

export interface HtmlSemanticSummary {
  title: string | null;
  headings: string[];
  links: Array<{ text: string; href: string | null }>;
  buttons: string[];
  inputs: Array<{ tag: string; type: string | null; name: string | null; placeholder: string | null }>;
  scripts: Array<{ src: string | null; inline: boolean }>;
  styles: Array<{ href: string | null; inline: boolean }>;
  ids: string[];
  stats: {
    bytes: number;
    headings: number;
    links: number;
    buttons: number;
    inputs: number;
    scripts: number;
    styles: number;
    ids: number;
  };
}

export interface HtmlSemanticDiff {
  before: HtmlSemanticSummary;
  after: HtmlSemanticSummary;
  changes: string[];
}

export interface FeedbackSurface {
  html: string;
  title: string | null;
  version: 1;
  createdAt: string;
  validation: HtmlValidationResult | null;
}

export interface ProjectsResponse {
  host: string;
  port: number;
  publicBaseUrl: string;
  generatedAt: string;
  projects: ProjectInfo[];
}

export interface HealthResponse {
  ok: boolean;
  uptimeSeconds: number;
  publicBaseUrl: string;
  localUrl: string;
  tailscaleServe: "configured" | "not_configured" | "unknown";
  projectCount: number;
  onlineProjectCount: number;
  generatedAt: string;
  warnings: string[];
}

export interface ViewerState {
  drawer: "collapsed" | "half" | "full";
  activeTab: "feedback" | "commands" | "diagnostics" | "activity";
  viewport: ViewportKey | "fluid";
}

export interface WorkspaceNote {
  id: string;
  text: string;
  createdAt: string;
  screenshotUrl?: string | null;
}

export interface ProjectWorkspace {
  projectId: string;
  notes: WorkspaceNote[];
  viewer: ViewerState;
  updatedAt: string;
}

export type ActivityEventKind =
  | "command"
  | "diagnostic"
  | "feedback"
  | "note"
  | "route"
  | "screenshot"
  | "system"
  | "viewer";

export interface ActivityEvent {
  id: string;
  projectId?: string;
  kind: ActivityEventKind;
  message: string;
  data?: unknown;
  createdAt: string;
}

export interface CommandRequest {
  command: string;
  cwd?: string;
}

export type CommandRunStatus = "running" | "exited" | "failed";

export interface CommandRun {
  id: string;
  projectId: string;
  command: string;
  cwd: string;
  status: CommandRunStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stdoutTail: string;
  stderrTail: string;
}

export interface CommandEvent {
  commandId: string;
  type: "start" | "stdout" | "stderr" | "exit" | "error";
  data: string | CommandRun;
  createdAt: string;
}

export interface CommandPreset {
  id: string;
  label: string;
  command: string;
  cwd?: string;
}

export type FeedbackStatus = "open" | "viewed" | "answered" | "resolved" | "stale";

export type FeedbackResponseKind = "approve" | "reject" | "unsure" | "note" | "broken" | "another_version";

export type FeedbackResponseMode =
  | "freeform"
  | "choice"
  | "approval"
  | "rating"
  | "inspection"
  | "mixed"
  | (string & {});

export interface GitStateSnapshot {
  repoRoot: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  diffHash: string | null;
  statusSummary: string;
}

export interface RuntimeStateSnapshot {
  projectId: string;
  projectName: string;
  sourcePath: string | null;
  routeMode: RouteMode;
  routeUrl: string;
  appPath: string;
  port: number;
  processCommand: string | null;
  portalVersion: string;
}

export interface CodeStateSnapshot {
  id: string;
  capturedAt: string;
  runtime: RuntimeStateSnapshot;
  git: GitStateSnapshot | null;
  fingerprint: string;
}

export interface FeedbackArtifact {
  id: string;
  type: "screenshot";
  label: string;
  url: string | null;
  viewport?: ViewportKey;
  capturedAt: string;
  state: CodeStateSnapshot;
}

export interface FeedbackResponse {
  id: string;
  kind: FeedbackResponseKind;
  text: string;
  choice?: string;
  data?: Record<string, unknown> | null;
  createdAt: string;
  state: CodeStateSnapshot;
}

export interface FeedbackEdit {
  id: string;
  targetId: string;
  selector: string;
  tagName: string;
  before: string;
  after: string;
  createdAt: string;
  state: CodeStateSnapshot;
}

export interface FeedbackMetrics {
  notifiedAt: string | null;
  notificationClickedAt: string | null;
  firstInteractionAt: string | null;
  answeredAt: string | null;
  requestToNotifyMs: number | null;
  notifyToOpenMs: number | null;
  openToAnswerMs: number | null;
  requestToAnswerMs: number | null;
}

export interface FeedbackRequest {
  id: string;
  projectId: string;
  projectName: string;
  canonicalProjectKey: string;
  projectAliases: string[];
  resolvedProjectId: string | null;
  projectAvailable: boolean;
  prompt: string;
  context: string | null;
  responseMode: FeedbackResponseMode;
  responseSpec: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  feedbackSurface: FeedbackSurface | null;
  appPath: string;
  choices: string[];
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  viewedAt: string | null;
  resolvedAt: string | null;
  notifiedAt: string | null;
  notificationClickedAt: string | null;
  firstInteractionAt: string | null;
  answeredAt: string | null;
  requestedState: CodeStateSnapshot;
  currentState: CodeStateSnapshot;
  answeredState: CodeStateSnapshot | null;
  isStale: boolean;
  staleReason: string | null;
  artifacts: FeedbackArtifact[];
  edits: FeedbackEdit[];
  responses: FeedbackResponse[];
  metrics: FeedbackMetrics;
}

export interface FeedbackMetricsSummary {
  totalRequests: number;
  answeredRequests: number;
  activeRequests: number;
  missingProjectRequests: number;
  medianRequestToAnswerMs: number | null;
  medianNotifyToOpenMs: number | null;
  medianOpenToAnswerMs: number | null;
  latestRequestToAnswerMs: number | null;
  improvementRate: number | null;
}

export interface NotificationSubscriptionRecord {
  id: string;
  endpoint: string;
  subscription: PushSubscriptionJSON;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}
