import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Artifact } from "@nib/protocol";
import { createNibClient, type CreateRequestInput, type NibClient } from "@nib/sdk";

export interface NibPlaywrightReporterOptions {
  client?: Pick<NibClient, "request">;
  includePassed?: boolean;
  title?: (test: PlaywrightTestCaseLike, result: PlaywrightTestResultLike) => string;
}

export interface PlaywrightTestCaseLike {
  title: string;
  titlePath?: () => string[];
  location?: { file: string; line: number; column: number };
  project?: {
    name?: string;
    use?: Record<string, unknown>;
  };
}

export interface PlaywrightTestResultLike {
  status: string;
  expectedStatus?: string;
  duration?: number;
  retry?: number;
  error?: { message?: string; stack?: string };
  errors?: Array<{ message?: string; stack?: string }>;
  attachments?: Array<{
    name: string;
    contentType: string;
    path?: string;
    body?: Buffer | string;
  }>;
}

export default class NibPlaywrightReporter {
  private readonly client: Pick<NibClient, "request">;
  private readonly includePassed: boolean;
  private readonly title: NonNullable<NibPlaywrightReporterOptions["title"]>;
  private readonly pending: Array<Promise<unknown>> = [];

  constructor(options: NibPlaywrightReporterOptions = {}) {
    this.client = options.client ?? createNibClient();
    this.includePassed = options.includePassed ?? false;
    this.title = options.title ?? ((test) => `Review Playwright result: ${test.title}`);
  }

  onTestEnd(test: PlaywrightTestCaseLike, result: PlaywrightTestResultLike): void {
    if (!this.includePassed && result.status === "passed") {
      return;
    }
    this.pending.push(this.createRequest(test, result));
  }

  async onEnd(): Promise<void> {
    await Promise.all(this.pending);
  }

  async createRequest(test: PlaywrightTestCaseLike, result: PlaywrightTestResultLike): Promise<void> {
    const artifacts = await artifactsFromAttachments(result.attachments ?? []);
    const request: CreateRequestInput = {
      title: this.title(test, result),
      source: { type: "automation", system: "playwright" },
      subject: {
        type: "test_result",
        id: test.titlePath?.().join(" > ") ?? test.title,
        title: test.title,
        metadata: {
          file: test.location?.file,
          line: test.location?.line,
          column: test.location?.column,
        },
      },
      artifacts,
      decision: {
        type: "approval",
        prompt: "Is this result acceptable?",
        options: [
          { id: "approve", label: "Accept" },
          { id: "changes_requested", label: "Request changes" },
        ],
      },
      metadata: {
        test: {
          title: test.title,
          path: test.titlePath?.(),
          status: result.status,
          expectedStatus: result.expectedStatus,
          durationMs: result.duration,
          retry: result.retry,
          errors: [...(result.errors ?? []), ...(result.error ? [result.error] : [])],
        },
        browser: browserMetadata(test.project?.use),
        device: deviceMetadata(test.project?.use),
        project: test.project?.name,
      },
    };

    await this.client.request(request);
  }
}

export async function artifactsFromAttachments(
  attachments: NonNullable<PlaywrightTestResultLike["attachments"]>,
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  for (const attachment of attachments) {
    if (!isReviewArtifact(attachment)) {
      continue;
    }
    const bytes = attachment.body === undefined ? await readFile(attachment.path!) : Buffer.from(attachment.body);
    const path = attachment.path ?? `${attachment.name}.${extensionFor(attachment.contentType)}`;
    artifacts.push({
      id: artifactId(attachment.name, artifacts.length),
      type: artifactType(attachment.contentType, attachment.name),
      title: attachment.name,
      mimeType: attachment.contentType,
      source: {
        type: "embedded",
        path,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
      },
      metadata: {
        filename: basename(path),
      },
    });
  }
  return artifacts;
}

function isReviewArtifact(attachment: { name: string; contentType: string; path?: string; body?: Buffer | string }): boolean {
  if (!attachment.path && attachment.body === undefined) {
    return false;
  }
  return /image|video|zip|trace|json|text|html/.test(attachment.contentType) || /screenshot|video|trace/i.test(attachment.name);
}

function artifactType(contentType: string, name: string): Artifact["type"] {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType === "text/html") return "html";
  if (contentType === "application/json") return "json";
  if (/trace/i.test(name)) return "file";
  return "file";
}

function artifactId(name: string, index: number): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact"}-${index + 1}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionFor(contentType: string): string {
  if (contentType.startsWith("image/png")) return "png";
  if (contentType.startsWith("image/jpeg")) return "jpg";
  if (contentType.startsWith("video/")) return "webm";
  if (contentType === "application/zip") return "zip";
  if (contentType === "application/json") return "json";
  return "bin";
}

function browserMetadata(use?: Record<string, unknown>): Record<string, unknown> {
  return compact({
    name: use?.browserName,
    viewport: use?.viewport,
    colorScheme: use?.colorScheme,
    locale: use?.locale,
    timezoneId: use?.timezoneId,
  });
}

function deviceMetadata(use?: Record<string, unknown>): Record<string, unknown> {
  return compact({
    deviceScaleFactor: use?.deviceScaleFactor,
    isMobile: use?.isMobile,
    hasTouch: use?.hasTouch,
    userAgent: use?.userAgent,
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
