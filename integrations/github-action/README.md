# `@nib/github-action`

Create a Nib Request from a pull request workflow run and leave GitHub evidence
behind without polling for the decision.

```yaml
jobs:
  nib:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      checks: write
      pull-requests: write
    steps:
      - uses: douglance/nib-request@v1
        with:
          nib-token: ${{ secrets.NIB_TOKEN }}
```

The action discovers the current pull request from the GitHub event payload,
lists workflow artifacts for the current run, creates a nonterminal `Nib
Approval` check, creates or updates one marker PR comment, creates a Nib Request,
patches the check/comment with the returned `reviewLink`, and exits. It does not
poll or hold the runner open while reviewers decide.

The request idempotency key is deterministic by repository, pull request number,
and head SHA. Rerunning the same head replays the same Nib request; pushing a new
head SHA creates the next review request/revision.

## Callback Contract

Nib Cloud should use the request `continuation` and `metadata.github` fields to
close the loop after the Action exits:

- `repository`
- `pullRequestNumber`
- `headSha`
- `checkRunId`
- `commentId`

When the Nib decision is approved, update check run `checkRunId` to
`status: "completed"` and `conclusion: "success"`, then patch comment
`commentId` with the approval result and review link. When changes are requested
or rejected, update the same check run to `status: "completed"` with
`conclusion: "failure"` or `conclusion: "action_required"` and patch the same
comment with the reviewer outcome. Do not create a second check or comment for
the same request.
