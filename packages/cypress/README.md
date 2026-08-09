# `@nib/cypress`

Register a Cypress Node event adapter that sends failed test artifacts to Nib.
The adapter maps Cypress result objects into the generic Nib protocol instead of
adding Cypress-specific protocol fields.

```ts
// cypress.config.ts
import { defineConfig } from "cypress";
import { nibCypressAdapter } from "@nib/cypress";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      nibCypressAdapter()(on, config);
      return config;
    },
  },
});
```

The generated request uses `subject.type = "test_run"` and standard artifact
types such as `image`, `video`, and `file`.
