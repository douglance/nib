# Nib Acceptance GitHub App

`manifest.json` is the registration configuration for the hosted Nib App. It is not evidence that an App has been registered or installed. The checked-in deployment remains disabled until the live setup checks pass.

| Permission | Used for |
| --- | --- |
| Checks: write | Create acceptance check runs for the recorded commit. |
| Metadata: read | Verify the selected repository's ID, owner, name, and default branch. |
| Pull requests: read | Receive PR head-change events and invalidate obsolete acceptance revisions. |

The App does not request repository-content write access, organization administration, or user OAuth authorization. Project linking separately requires an authenticated Nib project administrator and a signed ownership proof from a trusted workflow on the repository's default branch.

## Register the hosted App

1. Deploy the configured webhook receiver with acceptance still disabled. Confirm the production hostname and replace the URLs in `manifest.json` if hosting elsewhere.
2. Register the App in the intended GitHub account using this configuration. For the manifest handshake, provide an operator-controlled `redirect_url` and an unguessable state value at registration time; neither is a reusable secret to commit in this file. Alternatively, enter the same fields in GitHub's App settings form.
3. Store the generated App ID, private key, and webhook secret as `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` on the public Worker. Keep credential values out of repository files and terminal output.
4. Complete the [deployment preflight](../../docs/acceptance-operations.md), enable acceptance, and create the pilot team and project. Install the App on the selected pilot repository. Run the [Action's link mode](../github-action/README.md) from its default branch to establish the Nib project association.
5. Verify a real webhook delivery, pending check, accepted check, and a later revision that blocks reuse. Record the App slug, installation ID, repository ID, deployed revision, and evidence in the day-30 audit before treating registration as shipped.

GitHub documents the [manifest registration handshake](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) and the [check-run permission requirements](https://docs.github.com/en/rest/checks/runs). A registration configuration alone does not complete that handshake.

GitHub delivers installation and repository-access lifecycle events to Apps by default. The receiver continues validating and processing signed lifecycle webhooks when acceptance is paused; publishing, token exchange, and current-gate verification stay disabled. An unconfigured webhook secret returns `503` until the binding is installed. See [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation).
