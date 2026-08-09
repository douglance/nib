# `@nib/playwright`

Send failed Playwright runs to Nib with the screenshots, videos, traces, and
browser/device metadata needed for review.

```ts
// playwright.config.ts
export default {
  reporter: [
    ["list"],
    ["@nib/playwright", { includePassed: false }],
  ],
};
```

The reporter creates one Nib Request per captured test result. It reads
Playwright attachments from `TestResult.attachments`, converts file or body
content into protocol artifacts, and includes test, browser, project, device,
retry, duration, and error metadata.

Use `createNibClient()` from `@nib/sdk` when you need custom API URLs or tokens
in local scripts. In CI, `NIB_API_URL` and `NIB_TOKEN` are read by the SDK.
