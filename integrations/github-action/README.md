# Nib Acceptance GitHub Action

Use `mode: link` once from the repository default branch to connect a GitHub App installation to a Nib acceptance project. The workflow must have `permissions: id-token: write` so GitHub can issue the OIDC ownership proof.

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: nibtool/acceptance-action@v1
    with:
      mode: link
      project-id: ${{ vars.NIB_PROJECT_ID }}
      setup-token: ${{ secrets.NIB_ACCEPTANCE_SETUP_TOKEN }}
      installation-id: ${{ vars.NIB_GITHUB_INSTALLATION_ID }}
      allowed-workflows: ${{ github.workflow_ref }}
      gates: acceptance
```

The server accepts link mode only when the signed GitHub OIDC claims come from `push` or `workflow_dispatch` on the repository default branch, and the workflow ref belongs to the target repository on that branch. Remove `NIB_ACCEPTANCE_SETUP_TOKEN` from repository secrets after link mode succeeds. Publish and verify modes use only short-lived scoped workflow tokens from the GitHub OIDC exchange.
