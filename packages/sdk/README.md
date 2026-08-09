# `@nib/sdk`

Create Nib Requests from JavaScript and wait for decisions without depending on
one UI test runner or hosting provider.

```ts
import { createNibClient } from "@nib/sdk";

const nib = createNibClient({
  baseUrl: "https://nib.example.com",
  token: process.env.NIB_TOKEN,
});

const handle = await nib.request({
  title: "Approve checkout video",
  artifacts: [
    {
      id: "checkout-video",
      type: "video",
      source: {
        type: "external",
        url: "https://ci.example.com/artifacts/video.webm",
        sha256: "abc123",
        byteLength: 1234,
      },
    },
  ],
  decision: { type: "approval", prompt: "Ship this change?" },
  continuation: { type: "webhook", url: "https://ci.example.com/nib/callback" },
});

const result = await handle.wait();
console.log(result.status, result.decision?.outcome);
```

`handle.get()` reads the current request snapshot. `handle.events()` yields
request events by polling the event endpoint. `handle.wait()` resolves when the
request reaches a terminal status.

Webhook continuations use the protocol `continuation` field. Use
`parseWebhookContinuation()` in async callbacks when the hosting surface posts a
decision or event payload back to your service.
