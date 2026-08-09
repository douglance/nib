# @nib/delivery-adapters

Messaging and notification adapters for sending a Nib Request review link through Slack, Microsoft Teams, email, SMS, and push.

These adapters do not own workflow state. They render provider messages, call an injected transport function, and normalize provider callbacks into `@nib/protocol` `Decision` or `Feedback` objects. The caller remains responsible for storing requests, validating revisions, applying policy, and recording the protocol result as the source of truth.

## Install

```sh
npm install @nib/delivery-adapters @nib/protocol
```

## Use

```ts
import { createSlackAdapter } from "@nib/delivery-adapters";

const slack = createSlackAdapter({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  transport: async (message) => {
    // Call chat.postMessage or a queue owned by your application.
    return { providerMessageId: "provider-message-id" };
  },
});

await slack.send({
  destination: { type: "channel", id: "C123" },
  notification: {
    request,
    reviewUrl: "https://nib.example/review/req_123",
  },
});
```

Every adapter uses an injected transport function. The package contains no credentials and makes no live provider calls.

## Callback Normalization

Provider callbacks are normalized, not applied:

```ts
const result = await slack.normalizeCallback({
  request,
  rawBody,
  headers,
  body,
});

if (result.kind === "decision") {
  await protocolStore.recordDecision(result.decision);
}
```

Slack uses the standard `v0:{timestamp}:{rawBody}` HMAC hook when `signingSecret` is supplied. Email, SMS, Teams, and push adapters accept a generic `CallbackVerifier`, and `createHmacVerifier` is provided for common header-signed callbacks.

## Plain Text

All adapters keep a plain text representation available through `renderReviewText`. Email sends both text and HTML; Slack and Teams set provider text fields; SMS is text-only; push places the review URL in notification data.

## Exports

- `createSlackAdapter`
- `createTeamsAdapter`
- `createEmailAdapter`
- `createSmsAdapter`
- `createPushAdapter`
- `renderReviewText`
- `createHmacVerifier`
- `createSlackSignatureVerifier`
- `verifyCallbackSignature`
