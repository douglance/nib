import { describe, expect, it } from "vitest";
import {
  isPublishedVisualReview,
  parseReviewRoute,
  publicAttachmentUrl,
  publicResponseUrl,
  publicReviewRecord,
  reviewPage,
  reviewPath
} from "./review-page";

const accountId = "1ecb3e04-7ee7-4b7a-9da7-9f57e47f8a70";
const requestId = "0fa15337-037e-49a3-b929-a18b1205ead3";

describe("public review page", () => {
  it("routes one capability URL to page, data, response, and attachment actions", () => {
    expect(parseReviewRoute(`/r/${accountId}/${requestId}`)).toEqual({
      accountId,
      requestId,
      action: "page"
    });
    expect(parseReviewRoute(`/r/${accountId}/${requestId}/data`)?.action).toBe("data");
    expect(parseReviewRoute(`/r/${accountId}/${requestId}/respond`)?.action).toBe("respond");
    expect(parseReviewRoute(`/r/${accountId}/${requestId}/attachments/${requestId}`)).toMatchObject({
      action: "attachment",
      attachmentId: requestId
    });
    expect(parseReviewRoute(`/r/not-an-account/${requestId}`)).toBeNull();
    expect(parseReviewRoute(`/r/${accountId}/not-a-request`)).toBeNull();
  });

  it("renders a keyboard-accessible response interface instead of an app-only launcher", async () => {
    const response = reviewPage(accountId, requestId);
    const html = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain("<main");
    expect(html).toContain('id="review-media"');
    expect(html).toContain('for="review-comment"');
    expect(html).toContain('data-decision="approve"');
    expect(html).toContain('data-decision="reject"');
    expect(html).toContain('data-decision="comment"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('<link rel="icon" href="data:,">');
    expect(html).not.toContain("Open in Nib");
    expect(html).not.toContain("nib://");
    expect(html).not.toContain("Open this request in the installed Nib app.");
  });

  it("returns only review-safe data and rewrites attachment URLs to the capability route", () => {
    const view = publicReviewRecord({
      id: requestId,
      kind: "visual-review",
      title: "Landing page camera",
      prompt: "Approve this camera treatment",
      status: "open",
      allowText: true,
      source: "private-host / tmux:%12",
      target: { private: true },
      metadata: { secret: "not public" },
      attachments: [{
        id: "f8926dbf-34f0-44be-a3f2-d9bc8f48cb35",
        name: "review.png",
        type: "image",
        contentType: "image/png",
        url: "/attachments/f8926dbf-34f0-44be-a3f2-d9bc8f48cb35?access=media_token",
        metadata: { role: "preview", objectKey: "private" }
      }],
      responses: []
    }, accountId);

    expect(view).toEqual({
      id: requestId,
      kind: "visual-review",
      title: "Landing page camera",
      prompt: "Approve this camera treatment",
      status: "open",
      allowText: true,
      attachment: {
        name: "review.png",
        type: "image",
        contentType: "image/png",
        url: `/r/${accountId}/${requestId}/attachments/f8926dbf-34f0-44be-a3f2-d9bc8f48cb35?access=media_token`
      },
      response: null
    });
    expect(view).not.toHaveProperty("source");
    expect(view).not.toHaveProperty("target");
    expect(view).not.toHaveProperty("metadata");
  });

  it("generates the account-scoped capability URL returned to clients", () => {
    expect(reviewPath("https://nibtool.com", accountId, requestId)).toBe(
      `https://nibtool.com/r/${accountId}/${requestId}`
    );
    expect(reviewPath("https://nibtool.com", accountId.toUpperCase(), requestId)).toBe(
      `https://nibtool.com/r/${accountId}/${requestId}`
    );
    expect(parseReviewRoute(`/r/${accountId.toUpperCase()}/${requestId}`)?.accountId).toBe(accountId);
  });

  it("builds a capability URL suitable for rich notification media", () => {
    expect(publicAttachmentUrl(accountId, requestId, {
      id: "f8926dbf-34f0-44be-a3f2-d9bc8f48cb35",
      url: "/attachments/f8926dbf-34f0-44be-a3f2-d9bc8f48cb35?access=media_token"
    })).toBe(
      `/r/${accountId}/${requestId}/attachments/f8926dbf-34f0-44be-a3f2-d9bc8f48cb35?access=media_token`
    );
  });

  it("builds the public response endpoint used by notification content", () => {
    expect(publicResponseUrl("https://nibtool.com", accountId, requestId)).toBe(
      `https://nibtool.com/r/${accountId}/${requestId}/respond`
    );
  });

  it("only exposes published visual reviews through the capability route", () => {
    expect(isPublishedVisualReview({
      id: requestId,
      kind: "visual-review",
      publishedAt: "2026-08-30T20:00:00.000Z"
    })).toBe(true);
    expect(isPublishedVisualReview({ id: requestId, kind: "visual-review", publishedAt: null })).toBe(false);
    expect(isPublishedVisualReview({
      id: requestId,
      kind: "question",
      publishedAt: "2026-08-30T20:00:00.000Z"
    })).toBe(false);
  });
});
