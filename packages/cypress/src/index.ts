import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Artifact } from "@nib/protocol";
import { createNibClient, type CreateRequestInput, type NibClient } from "@nib/sdk";

export interface NibCypressAdapterOptions {
  client?: Pick<NibClient, "request">;
  includePassed?: boolean;
}

export type CypressOn = (event: string, handler: (...args: unknown[]) => unknown) => void;

export interface CypressConfigLike {
  projectRoot?: string;
  video?: boolean;
  screenshotsFolder?: string;
  videosFolder?: string;
  browser?: {
    name?: string;
    family?: string;
    channel?: string;
    displayName?: string;
    version?: string;
    majorVersion?: number | string;
    isHeadless?: boolean;
    isHeaded?: boolean;
  };
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface CypressSpecLike {
  name?: string;
  relative?: string;
  absolute?: string;
}

export interface CypressRunResultLike {
  video?: string | null;
  stats?: {
    failures?: number;
    tests?: number;
    passes?: number;
    duration?: number;
  };
  tests?: Array<{
    title?: string[];
    state?: string;
    attempts?: Array<{
      state?: string;
      error?: { message?: string; stack?: string };
      screenshots?: Array<{ path: string; name?: string }>;
    }>;
  }>;
}

export function nibCypressAdapter(options: NibCypressAdapterOptions = {}) {
  const client = options.client ?? createNibClient();
  const includePassed = options.includePassed ?? false;

  return function setupNodeEvents(on: CypressOn, config: CypressConfigLike): CypressConfigLike {
    on("after:spec", async (spec: unknown, results: unknown) => {
      const request = await requestFromCypressResult(spec as CypressSpecLike, results as CypressRunResultLike, config);
      if (!request || (!includePassed && (results as CypressRunResultLike).stats?.failures === 0)) {
        return;
      }
      await client.request(request);
    });
    return config;
  };
}

export async function requestFromCypressResult(
  spec: CypressSpecLike,
  result: CypressRunResultLike,
  config: CypressConfigLike,
): Promise<CreateRequestInput | null> {
  const artifacts = await artifactsFromCypressResult(result);
  if (artifacts.length === 0 && result.stats?.failures === 0) {
    return null;
  }

  return {
    title: `Review test run: ${spec.relative ?? spec.name ?? "unknown spec"}`,
    source: { type: "automation", system: "cypress" },
    subject: {
      type: "test_run",
      id: spec.relative ?? spec.absolute ?? spec.name,
      title: spec.name ?? spec.relative,
      metadata: {
        file: spec.relative ?? spec.absolute,
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
      result: {
        failures: result.stats?.failures,
        tests: result.stats?.tests,
        passes: result.stats?.passes,
        durationMs: result.stats?.duration,
        failedTests: failedTests(result),
      },
      browser: {
        name: config.browser?.name,
        family: config.browser?.family,
        channel: config.browser?.channel,
        version: config.browser?.version,
        headless: config.browser?.isHeadless,
        viewport: viewport(config),
      },
    },
  };
}

export async function artifactsFromCypressResult(result: CypressRunResultLike): Promise<Artifact[]> {
  const paths = [
    ...(result.video ? [{ path: result.video, contentType: "video/mp4", title: "Video" }] : []),
    ...screenshotPaths(result).map((path) => ({ path, contentType: "image/png", title: "Screenshot" })),
  ];
  const artifacts: Artifact[] = [];

  for (const entry of paths) {
    const info = await stat(entry.path);
    artifacts.push({
      id: `${artifactId(entry.title)}-${artifacts.length + 1}`,
      type: entry.contentType.startsWith("image/") ? "image" : "video",
      title: entry.title,
      mimeType: entry.contentType,
      source: {
        type: "embedded",
        path: entry.path,
        sha256: createHash("sha256").update(`${entry.path}:${info.size}:${info.mtimeMs}`).digest("hex"),
        byteLength: info.size,
      },
      metadata: {
        filename: basename(entry.path),
      },
    });
  }

  return artifacts;
}

function screenshotPaths(result: CypressRunResultLike): string[] {
  return (
    result.tests?.flatMap((test) =>
      test.attempts?.flatMap((attempt) => attempt.screenshots?.map((screenshot) => screenshot.path) ?? []) ?? [],
    ) ?? []
  );
}

function failedTests(result: CypressRunResultLike): Array<{ title?: string[]; error?: { message?: string; stack?: string } }> {
  return (
    result.tests
      ?.filter((test) => test.state === "failed" || test.attempts?.some((attempt) => attempt.state === "failed"))
      .map((test) => ({
        title: test.title,
        error: test.attempts?.find((attempt) => attempt.error)?.error,
      })) ?? []
  );
}

function viewport(config: CypressConfigLike): { width?: number; height?: number } | undefined {
  if (config.viewportWidth === undefined && config.viewportHeight === undefined) {
    return undefined;
  }
  return { width: config.viewportWidth, height: config.viewportHeight };
}

function artifactId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact";
}
