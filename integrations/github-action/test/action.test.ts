import assert from "node:assert/strict";
import { test } from "node:test";
import type { Artifact } from "@nib/protocol";
import type { CreateRequestInput } from "@nib/sdk";
import { createRequestInput, runGitHubAction } from "../src/index.ts";

test("creates a request input from PR and workflow artifacts", () => {
  const request = createRequestInput({
    repository: "owner/repo",
    serverUrl: "https://github.com",
    runId: "123",
    sha: "abc",
    pullRequest: { number: 42, title: "Checkout", html_url: "https://github.com/owner/repo/pull/42" },
    artifacts: [
      {
        id: 1,
        name: "playwright-report",
        size_in_bytes: 100,
        archive_download_url: "https://api.github.com/artifacts/1/zip",
        sha256: "abcd",
      },
    ],
  });

  assert.equal(request.subject?.type, "pull_request");
  assert.equal(request.continuation?.type, "github_event");
  assert.equal(request.artifacts?.length, 0);
  assert.equal(JSON.stringify(request).includes("api.github.com/artifacts/1/zip"), false);
  assert.equal(request.idempotencyKey, "github-action:owner/repo:pr:42:sha:abc");
  const github = request.metadata?.github as Record<string, unknown>;
  assert.equal(github.repository, "owner/repo");
  assert.equal(github.pullRequestNumber, 42);
  assert.equal(github.headSha, "abc");
});

test("creates request, pending check, and marker comment with review link", async () => {
  const requests: CreateRequestInput[] = [];
  const githubCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    githubCalls.push({ url, init });
    if (url.endsWith("/actions/runs/123/artifacts")) {
      return json({
        artifacts: [
          {
            id: 9,
            name: "trace",
            size_in_bytes: 10,
            archive_download_url: "https://api.github.com/repos/owner/repo/actions/artifacts/9/zip",
          },
        ],
      });
    }
    if (url.endsWith("/actions/artifacts/9/zip")) {
      return new Response(Buffer.from("trace-zip"), { status: 200 });
    }
    if (url.endsWith("/issues/42/comments?per_page=100")) {
      return json([]);
    }
    if (url.endsWith("/check-runs")) {
      return json({ id: 7001 });
    }
    if (url.endsWith("/issues/42/comments")) {
      return json({ id: 8001 });
    }
    return json({});
  };

  await runGitHubAction({
    env: {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: "abc",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_GITHUB_TOKEN: "ghs",
      INPUT_NIB_TOKEN: "nib",
    },
    fetch,
    readEvent: async () => ({
      pull_request: {
        number: 42,
        title: "Checkout",
        html_url: "https://github.com/owner/repo/pull/42",
        head: { sha: "abc", ref: "feature" },
      },
    }),
    nibClient: {
      request: async (input) => {
        requests.push(input);
        return { id: "req_1", reviewLink: "https://nibtool.com/review/token" } as never;
      },
      uploadArtifact: async () => ({ id: "art_1" }) as never,
    },
  });

  assert.equal(requests.length, 1);
  const github = requests[0].metadata?.github as Record<string, unknown>;
  assert.equal(github.checkRunId, 7001);
  assert.equal(github.commentId, 8001);
  assert.equal(githubCalls.some((call) => call.url.includes("/events")), false);
  const checkCreate = githubCalls.find((call) => call.url.endsWith("/check-runs"));
  const checkPatch = githubCalls.find((call) => call.url.endsWith("/check-runs/7001"));
  const commentPatch = githubCalls.find((call) => call.url.endsWith("/issues/comments/8001"));
  assert.equal(JSON.parse(String(checkCreate?.init?.body)).name, "Nib Approval");
  assert.equal(JSON.parse(String(checkCreate?.init?.body)).status, "in_progress");
  assert.equal("conclusion" in JSON.parse(String(checkCreate?.init?.body)), false);
  assert.equal(String(checkPatch?.init?.body).includes("https://nibtool.com/review/token"), true);
  assert.equal(String(commentPatch?.init?.body).includes("<!-- nib-approval:owner/repo#42 -->"), true);
  assert.equal(String(commentPatch?.init?.body).includes("https://nibtool.com/review/token"), true);
});

test("updates existing marker comment on rerun without creating a second comment", async () => {
  const githubCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    githubCalls.push({ url, init });
    if (url.endsWith("/actions/runs/999/artifacts")) {
      return json({ artifacts: [] });
    }
    if (url.endsWith("/issues/42/comments?per_page=100")) {
      return json([{ id: 8001, body: "<!-- nib-approval:owner/repo#42 -->\nOld link" }]);
    }
    if (url.endsWith("/check-runs")) {
      return json({ id: 7001 });
    }
    return json({});
  };

  await runGitHubAction({
    env: {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "999",
      GITHUB_SHA: "abc",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_GITHUB_TOKEN: "ghs",
      INPUT_NIB_TOKEN: "nib",
    },
    fetch,
    readEvent: async () => ({
      pull_request: {
        number: 42,
        title: "Checkout",
        html_url: "https://github.com/owner/repo/pull/42",
        head: { sha: "abc", ref: "feature" },
      },
    }),
    nibClient: {
      request: async () => ({ id: "req_1", reviewLink: "https://nibtool.com/review/token" }) as never,
      uploadArtifact: async () => ({ id: "art_1" }) as never,
    },
  });

  assert.equal(githubCalls.some((call) => call.url.endsWith("/issues/42/comments") && call.init?.method === "POST"), false);
  const patch = githubCalls.find((call) => call.url.endsWith("/issues/comments/8001"));
  assert.equal(patch?.init?.method, "PATCH");
  assert.equal(String(patch?.init?.body).includes("https://nibtool.com/review/token"), true);
});

test("reuses existing in-progress Nib Approval check for the same head SHA", async () => {
  const githubCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    githubCalls.push({ url, init });
    if (url.endsWith("/actions/runs/999/artifacts")) return json({ artifacts: [] });
    if (url.includes("/commits/abc/check-runs?check_name=Nib+Approval")) {
      return json({ check_runs: [{ id: 7001, name: "Nib Approval", status: "in_progress", head_sha: "abc" }] });
    }
    if (url.endsWith("/issues/42/comments?per_page=100")) {
      return json([{ id: 8001, body: "<!-- nib-approval:owner/repo#42 -->\nOld link" }]);
    }
    return json({});
  };

  await runGitHubAction({
    env: {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "999",
      GITHUB_SHA: "abc",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_GITHUB_TOKEN: "ghs",
      INPUT_NIB_TOKEN: "nib",
    },
    fetch,
    readEvent: async () => ({
      pull_request: {
        number: 42,
        title: "Checkout",
        html_url: "https://github.com/owner/repo/pull/42",
        head: { sha: "abc", ref: "feature" },
      },
    }),
    nibClient: {
      request: async () => ({ id: "req_1", reviewLink: "https://nibtool.com/review/token" }) as never,
      uploadArtifact: async () => ({ id: "art_1" }) as never,
    },
  });

  assert.equal(githubCalls.some((call) => call.url.endsWith("/check-runs") && call.init?.method === "POST"), false);
  assert.equal(githubCalls.some((call) => call.url.endsWith("/check-runs/7001") && call.init?.method === "PATCH"), true);
});

test("finalizes check and marker comment with retryable error when Nib creation fails", async () => {
  const githubCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    githubCalls.push({ url, init });
    if (url.endsWith("/actions/runs/123/artifacts")) return json({ artifacts: [] });
    if (url.includes("/commits/abc/check-runs?check_name=Nib+Approval")) return json({ check_runs: [] });
    if (url.endsWith("/issues/42/comments?per_page=100")) return json([]);
    if (url.endsWith("/issues/42/comments")) return json({ id: 8001 });
    if (url.endsWith("/check-runs")) return json({ id: 7001 });
    return json({});
  };

  await assert.rejects(
    () =>
      runGitHubAction({
        env: {
          GITHUB_API_URL: "https://api.github.com",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_RUN_ID: "123",
          GITHUB_SHA: "abc",
          GITHUB_EVENT_PATH: "event.json",
          INPUT_GITHUB_TOKEN: "ghs",
          INPUT_NIB_TOKEN: "nib",
        },
        fetch,
        readEvent: async () => ({
          pull_request: {
            number: 42,
            title: "Checkout",
            html_url: "https://github.com/owner/repo/pull/42",
            head: { sha: "abc", ref: "feature" },
          },
        }),
        nibClient: {
          request: async () => {
            throw new Error("Nib unavailable");
          },
          uploadArtifact: async () => ({ id: "art_1" }) as never,
        },
      }),
    /Nib unavailable/,
  );

  const checkFailure = githubCalls.find((call) => call.url.endsWith("/check-runs/7001") && call.init?.method === "PATCH");
  const commentFailure = githubCalls.find((call) => call.url.endsWith("/issues/comments/8001") && call.init?.method === "PATCH");
  assert.equal(JSON.parse(String(checkFailure?.init?.body)).status, "completed");
  assert.equal(JSON.parse(String(checkFailure?.init?.body)).conclusion, "failure");
  assert.equal(String(commentFailure?.init?.body).includes("retry"), true);
  assert.equal(String(commentFailure?.init?.body).includes("<!-- nib-approval:owner/repo#42 -->"), true);
});

test("uploads GitHub artifact bytes to Nib so private archive URL is not guest evidence", async () => {
  const requests: CreateRequestInput[] = [];
  const uploads: Array<{ requestId: string; input: { bytes: Uint8Array; sha256: string; byteLength: number } }> = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/actions/runs/123/artifacts")) {
      return json({
        artifacts: [
          {
            id: 9,
            name: "trace",
            size_in_bytes: 9,
            archive_download_url: "https://api.github.com/repos/owner/repo/actions/artifacts/9/zip",
          },
        ],
      });
    }
    if (url.endsWith("/actions/artifacts/9/zip")) {
      return new Response(Buffer.from("trace-zip"), { status: 200, headers: { "content-length": "9" } });
    }
    if (url.includes("/commits/abc/check-runs?check_name=Nib+Approval")) return json({ check_runs: [] });
    if (url.endsWith("/issues/42/comments?per_page=100")) return json([]);
    if (url.endsWith("/issues/42/comments")) return json({ id: 8001 });
    if (url.endsWith("/check-runs")) return json({ id: 7001 });
    return json({});
  };

  await runGitHubAction({
    env: {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: "abc",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_GITHUB_TOKEN: "ghs",
      INPUT_NIB_TOKEN: "nib",
    },
    fetch,
    readEvent: async () => ({
      pull_request: {
        number: 42,
        title: "Checkout",
        html_url: "https://github.com/owner/repo/pull/42",
        head: { sha: "abc", ref: "feature" },
      },
    }),
    nibClient: {
      request: async (input) => {
        requests.push(input);
        return { id: "req_1", reviewLink: "https://nibtool.com/review/token" } as never;
      },
      uploadArtifact: async (requestId, input) => {
        uploads.push({ requestId, input });
        return {
          id: "hosted-trace",
          type: "file",
          source: { type: "external", url: "https://nibtool.com/artifacts/hosted-trace", sha256: input.sha256, byteLength: input.byteLength },
        } as Artifact;
      },
    },
  });

  assert.equal(requests[0].artifacts?.length, 0);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].requestId, "req_1");
  assert.equal(uploads[0].input.byteLength, 9);
  assert.equal(JSON.stringify(requests[0]).includes("actions/artifacts/9/zip"), false);
});

test("omits artifact when content length lies beyond max bytes after read", async () => {
  const uploads: unknown[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/actions/runs/123/artifacts")) {
      return json({
        artifacts: [
          {
            id: 9,
            name: "huge",
            size_in_bytes: 1,
            archive_download_url: "https://api.github.com/repos/owner/repo/actions/artifacts/9/zip",
          },
        ],
      });
    }
    if (url.endsWith("/actions/artifacts/9/zip")) {
      return new Response(new Uint8Array(100 * 1024 * 1024 + 1), { status: 200, headers: { "content-length": "1" } });
    }
    if (url.includes("/commits/abc/check-runs?check_name=Nib+Approval")) return json({ check_runs: [] });
    if (url.endsWith("/issues/42/comments?per_page=100")) return json([]);
    if (url.endsWith("/issues/42/comments")) return json({ id: 8001 });
    if (url.endsWith("/check-runs")) return json({ id: 7001 });
    return json({});
  };

  await runGitHubAction({
    env: {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: "abc",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_GITHUB_TOKEN: "ghs",
      INPUT_NIB_TOKEN: "nib",
    },
    fetch,
    readEvent: async () => ({
      pull_request: {
        number: 42,
        title: "Checkout",
        html_url: "https://github.com/owner/repo/pull/42",
        head: { sha: "abc", ref: "feature" },
      },
    }),
    nibClient: {
      request: async () => ({ id: "req_1", reviewLink: "https://nibtool.com/review/token" }) as never,
      uploadArtifact: async (_requestId, input) => {
        uploads.push(input);
        return { id: "art_1" } as never;
      },
    },
  });

  assert.equal(uploads.length, 0);
});

test("omits artifacts whose archive cannot be content-addressed", async () => {
  const requests: CreateRequestInput[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/actions/runs/123/artifacts")) {
      return json({
        artifacts: [
          {
            id: 9,
            name: "broken",
            size_in_bytes: 10,
            archive_download_url: "https://api.github.com/repos/owner/repo/actions/artifacts/9/zip",
          },
        ],
      });
    }
    if (url.endsWith("/actions/artifacts/9/zip")) {
      return json({ error: "gone" }, 410);
    }
    if (url.endsWith("/issues/42/comments?per_page=100")) {
      return json([]);
    }
    if (url.endsWith("/check-runs")) {
      return json({ id: 7001 });
    }
    if (url.endsWith("/issues/42/comments")) {
      return json({ id: 8001 });
    }
    return json({});
  };

  await runGitHubAction({
    env: {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: "abc",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_GITHUB_TOKEN: "ghs",
      INPUT_NIB_TOKEN: "nib",
    },
    fetch,
    readEvent: async () => ({
      pull_request: {
        number: 42,
        title: "Checkout",
        html_url: "https://github.com/owner/repo/pull/42",
        head: { sha: "abc", ref: "feature" },
      },
    }),
    nibClient: {
      request: async (input) => {
        requests.push(input);
        return { id: "req_1", reviewLink: "https://nibtool.com/review/token" } as never;
      },
      uploadArtifact: async () => ({ id: "art_1" }) as never,
    },
  });

  assert.equal(requests[0].artifacts?.length, 0);
});

test("uses SDK default hosted origin for Nib request creation", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/actions/runs/123/artifacts")) {
      return json({ artifacts: [] });
    }
    if (url.endsWith("/issues/42/comments?per_page=100")) {
      return json([]);
    }
    if (url.endsWith("/check-runs")) {
      return json({ id: 7001 });
    }
    if (url.endsWith("/issues/42/comments")) {
      return json({ id: 8001 });
    }
    if (url.endsWith("/v1/requests")) {
      const request = JSON.parse(String(init?.body));
      return json({ request, status: "pending", reviewLink: "https://nibtool.com/review/token" });
    }
    return json({});
  };

  await runGitHubAction({
    env: {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: "abc",
      GITHUB_EVENT_PATH: "event.json",
      INPUT_GITHUB_TOKEN: "ghs",
      INPUT_NIB_TOKEN: "nib",
    },
    fetch,
    readEvent: async () => ({
      pull_request: {
        number: 42,
        title: "Checkout",
        html_url: "https://github.com/owner/repo/pull/42",
        head: { sha: "abc", ref: "feature" },
      },
    }),
  });

  const nibCall = calls.find((call) => call.url.endsWith("/v1/requests"));
  assert.equal(nibCall?.url, "https://nibtool.com/v1/requests");
  assert.equal(new Headers(nibCall?.init?.headers).get("idempotency-key"), "github-action:owner/repo:pr:42:sha:abc");
  assert.equal(calls.some((call) => call.url.includes("api.nibtool.com")), false);
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
