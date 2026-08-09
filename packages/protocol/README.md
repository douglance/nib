# `@nib/protocol`

Use this package when software must create or consume a portable Nib Request.
The package is Apache-2.0 licensed and does not require Nib Cloud.

```ts
import type { NibRequest } from "@nib/protocol";

const request: NibRequest = {
  id: "req_checkout",
  formatVersion: "1.0",
  revision: 1,
  title: "Approve checkout redesign",
  source: { type: "agent", system: "codex" },
  artifacts: [],
  decision: { type: "approval", prompt: "Ship this change?" },
  createdAt: "2026-08-09T15:04:00Z",
};
```

The protocol uses five stable concepts: request, artifact, decision, feedback,
and event. Unknown fields remain valid within protocol major version 1.

JSON Schema documents are in [`schemas/protocol`](../../schemas/protocol).
The Rust source of truth is [`crates/nib-protocol`](../../crates/nib-protocol).
