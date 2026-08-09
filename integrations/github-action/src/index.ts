import { readFile } from "node:fs/promises";
import { createNibClient, type CreateRequestInput, type NibClient } from "@nib/sdk";

export interface GitHubActionEnv {
  GITHUB_API_URL?: string;
  GITHUB_SERVER_URL?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_RUN_ID?: string;
  GITHUB_SHA?: string;
  GITHUB_EVENT_PATH?: string;
  INPUT_NIB_API_URL?: string;
  INPUT_NIB_TOKEN?: string;
  INPUT_GITHUB_TOKEN?: string;
  INPUT_TITLE?: string;
}

export interface RunGitHubActionOptions {
  env?: GitHubActionEnv;
  fetch?: typeof fetch;
  nibClient?: Pick<NibClient, "request" | "uploadArtifact">;
  readEvent?: (path: string) => Promise<unknown>;
}

interface GitHubArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  archive_download_url: string;
  expired?: boolean;
  sha256?: string;
}

interface DownloadedGitHubArtifact extends GitHubArtifact {
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
}

interface GitHubComment {
  id: number;
  body?: string;
}

interface GitHubIdResponse {
  id: number;
}

interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  head_sha?: string;
}

interface PullRequestEvent {
  pull_request?: {
    number: number;
    html_url?: string;
    title?: string;
    head?: { sha?: string; ref?: string };
  };
}

const maxArtifactBytes = 100 * 1024 * 1024;

export async function runGitHubAction(options: RunGitHubActionOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const repository = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const runId = required(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const githubToken = required(env.INPUT_GITHUB_TOKEN, "INPUT_GITHUB_TOKEN");
  const eventPath = required(env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH");
  const event = (await (options.readEvent ?? readJson)(eventPath)) as PullRequestEvent;
  const pullRequest = event.pull_request;

  if (!pullRequest) {
    console.log("Nib Request action skipped because this event is not a pull request.");
    return;
  }

  const apiUrl = trimTrailingSlash(env.GITHUB_API_URL ?? "https://api.github.com");
  const serverUrl = trimTrailingSlash(env.GITHUB_SERVER_URL ?? "https://github.com");
  const headSha = required(env.GITHUB_SHA ?? pullRequest.head?.sha, "GITHUB_SHA or pull_request.head.sha");
  const downloadedArtifacts = await downloadArtifacts(
    fetchImpl,
    githubToken,
    await listArtifacts(fetchImpl, apiUrl, githubToken, repository, runId),
  );
  const marker = markerFor(repository, pullRequest.number);
  const commentId =
    (await findMarkerComment(fetchImpl, apiUrl, githubToken, repository, pullRequest.number, marker))?.id ??
    (await createComment(fetchImpl, apiUrl, githubToken, repository, pullRequest.number, pendingCommentBody(marker))).id;
  const checkRunId =
    (await findInProgressCheck(fetchImpl, apiUrl, githubToken, repository, headSha))?.id ??
    (
      await createCheck(fetchImpl, apiUrl, githubToken, repository, {
        name: "Nib Approval",
        head_sha: headSha,
        status: "in_progress",
        output: {
          title: "Nib Approval pending",
          summary: "Nib review is being prepared.",
        },
      })
    ).id;
  const nibClient =
    options.nibClient ??
    createNibClient({
      baseUrl: env.INPUT_NIB_API_URL,
      token: env.INPUT_NIB_TOKEN,
      fetch: fetchImpl,
    });

  const requestInput = createRequestInput({
    repository,
    serverUrl,
    runId,
    sha: headSha,
    title: env.INPUT_TITLE,
    pullRequest,
    artifacts: [],
    checkRunId,
    commentId,
  });
  const summaryUrl = `${serverUrl}/${repository}/actions/runs/${runId}`;
  try {
    const handle = await nibClient.request(requestInput);
    const reviewLink = required(handle.reviewLink, "Nib create response reviewLink");
    for (const artifact of downloadedArtifacts) {
      await nibClient.uploadArtifact(handle.id, {
        id: `github-artifact-${artifact.id}`,
        idempotencyKey: `github-artifact:${repository}:pr:${pullRequest.number}:sha:${headSha}:artifact:${artifact.id}`,
        title: artifact.name,
        type: "file",
        mimeType: "application/zip",
        byteLength: artifact.bytes.byteLength,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        metadata: {
          githubArtifactId: artifact.id,
          githubArtifactName: artifact.name,
          source: "github-actions",
        },
      });
    }
    await updateCheck(fetchImpl, apiUrl, githubToken, repository, checkRunId, {
      status: "in_progress",
      output: {
        title: "Nib Approval pending",
        summary: `Nib review ${handle.id} is waiting for approval.\n\nReview: ${reviewLink}\nWorkflow run: ${summaryUrl}`,
      },
    });
    await updateComment(
      fetchImpl,
      apiUrl,
      githubToken,
      repository,
      commentId,
      reviewCommentBody(marker, handle.id, reviewLink, summaryUrl),
    );
  } catch (error) {
    await markGitHubFailure(fetchImpl, apiUrl, githubToken, repository, checkRunId, commentId, marker, error);
    throw error;
  }
}

export function createRequestInput(input: {
  repository: string;
  serverUrl: string;
  runId: string;
  sha?: string;
  title?: string;
  pullRequest: NonNullable<PullRequestEvent["pull_request"]>;
  artifacts: GitHubArtifact[];
  checkRunId?: number;
  commentId?: number;
}): CreateRequestInput {
  return {
    idempotencyKey: `github-action:${input.repository}:pr:${input.pullRequest.number}:sha:${input.sha}`,
    title: input.title ?? `Review PR #${input.pullRequest.number}: ${input.pullRequest.title ?? input.repository}`,
    source: { type: "automation", system: "github-actions", reference: `${input.repository}/actions/runs/${input.runId}` },
    subject: {
      type: "pull_request",
      id: `${input.repository}#${input.pullRequest.number}`,
      title: input.pullRequest.title,
      metadata: {
        repository: input.repository,
        number: input.pullRequest.number,
        url: input.pullRequest.html_url,
        sha: input.sha,
        ref: input.pullRequest.head?.ref,
      },
    },
    artifacts: [],
    decision: {
      type: "approval",
      prompt: "Is this pull request ready to merge?",
      options: [
        { id: "approve", label: "Approve" },
        { id: "changes_requested", label: "Request changes" },
      ],
    },
    continuation: {
      type: "github_event",
      repository: input.repository,
      checkRunId: input.checkRunId,
      commentId: input.commentId,
      pullRequestNumber: input.pullRequest.number,
      headSha: input.sha,
    },
    metadata: {
      workflowRunUrl: `${input.serverUrl}/${input.repository}/actions/runs/${input.runId}`,
      github: {
        repository: input.repository,
        pullRequestNumber: input.pullRequest.number,
        headSha: input.sha,
        checkRunId: input.checkRunId,
        commentId: input.commentId,
      },
    },
  };
}

async function listArtifacts(
  fetchImpl: typeof fetch,
  apiUrl: string,
  token: string,
  repository: string,
  runId: string,
): Promise<GitHubArtifact[]> {
  const response = await githubJson<{ artifacts: GitHubArtifact[] }>(
    fetchImpl,
    token,
    `${apiUrl}/repos/${repository}/actions/runs/${runId}/artifacts`,
  );
  return response.artifacts ?? [];
}

async function createCheck(
  fetchImpl: typeof fetch,
  apiUrl: string,
  token: string,
  repository: string,
  body: Record<string, unknown>,
): Promise<GitHubIdResponse> {
  return githubJson(fetchImpl, token, `${apiUrl}/repos/${repository}/check-runs`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function findInProgressCheck(
  fetchImpl: typeof fetch,
  apiUrl: string,
  token: string,
  repository: string,
  headSha: string,
): Promise<GitHubCheckRun | undefined> {
  const search = new URLSearchParams({ check_name: "Nib Approval" });
  const response = await githubJson<{ check_runs: GitHubCheckRun[] }>(
    fetchImpl,
    token,
    `${apiUrl}/repos/${repository}/commits/${headSha}/check-runs?${search.toString()}`,
  );
  return (response.check_runs ?? []).find(
    (checkRun) => checkRun.name === "Nib Approval" && checkRun.status === "in_progress" && (!checkRun.head_sha || checkRun.head_sha === headSha),
  );
}

async function updateCheck(
  fetchImpl: typeof fetch,
  apiUrl: string,
  token: string,
  repository: string,
  checkRunId: number,
  body: Record<string, unknown>,
): Promise<void> {
  await githubJson(fetchImpl, token, `${apiUrl}/repos/${repository}/check-runs/${checkRunId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function findMarkerComment(
  fetchImpl: typeof fetch,
  apiUrl: string,
  token: string,
  repository: string,
  issueNumber: number,
  marker: string,
): Promise<GitHubComment | undefined> {
  const comments = await githubJson<GitHubComment[]>(
    fetchImpl,
    token,
    `${apiUrl}/repos/${repository}/issues/${issueNumber}/comments?per_page=100`,
  );
  return comments.find((comment) => comment.body?.includes(marker));
}

async function createComment(
  fetchImpl: typeof fetch,
  apiUrl: string,
  token: string,
  repository: string,
  issueNumber: number,
  body: string,
): Promise<GitHubIdResponse> {
  return githubJson(fetchImpl, token, `${apiUrl}/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function updateComment(
  fetchImpl: typeof fetch,
  apiUrl: string,
  token: string,
  repository: string,
  commentId: number,
  body: string,
): Promise<void> {
  await githubJson(fetchImpl, token, `${apiUrl}/repos/${repository}/issues/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

async function githubJson<T>(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-github-api-version", "2022-11-28");
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetchImpl(url, { ...init, headers });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function downloadArtifacts(
  fetchImpl: typeof fetch,
  token: string,
  artifacts: GitHubArtifact[],
): Promise<DownloadedGitHubArtifact[]> {
  const results = await Promise.all(
    artifacts.map(async (artifact) => {
      if (artifact.expired) {
        return undefined;
      }
      const response = await fetchImpl(artifact.archive_download_url, {
        headers: {
          accept: "application/zip",
          authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        console.warn(`Skipping GitHub artifact ${artifact.id}; archive download failed with ${response.status}.`);
        return undefined;
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxArtifactBytes) {
        console.warn(`Skipping GitHub artifact ${artifact.id}; archive is larger than ${maxArtifactBytes} bytes.`);
        return undefined;
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > maxArtifactBytes) {
        console.warn(`Skipping GitHub artifact ${artifact.id}; archive expanded beyond ${maxArtifactBytes} bytes.`);
        return undefined;
      }
      return {
        ...artifact,
        bytes: new Uint8Array(bytes),
        size_in_bytes: bytes.byteLength,
        sha256: await sha256(bytes),
      };
    }),
  );
  return results.filter((artifact): artifact is DownloadedGitHubArtifact => artifact !== undefined);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function markerFor(repository: string, pullRequestNumber: number): string {
  return `<!-- nib-approval:${repository}#${pullRequestNumber} -->`;
}

function pendingCommentBody(marker: string): string {
  return `${marker}\nNib Approval is being prepared.`;
}

function reviewCommentBody(marker: string, requestId: string, reviewLink: string, summaryUrl: string): string {
  return `${marker}\nNib Approval is waiting for review.\n\nReview: ${reviewLink}\nRequest: ${requestId}\nWorkflow run: ${summaryUrl}`;
}

async function markGitHubFailure(
  fetchImpl: typeof fetch,
  apiUrl: string,
  token: string,
  repository: string,
  checkRunId: number,
  commentId: number,
  marker: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await Promise.allSettled([
    updateCheck(fetchImpl, apiUrl, token, repository, checkRunId, {
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Nib Approval setup failed",
        summary: `Nib could not create or update the review. This is retryable.\n\nError: ${message}`,
      },
    }),
    updateComment(fetchImpl, apiUrl, token, repository, commentId, `${marker}\nNib Approval setup failed with a retryable error.\n\nError: ${message}`),
  ]);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGitHubAction().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
