# Trusted exact-URL intake policy

`pull_requests.jsonl` is an action-scope boundary. Adding a row records one
exact pull request for the review workflow; it is not an approval or evidence
that the pull request is safe.

- Accept only an exact <org> pull request URL already present in the current
  task context or in live evidence from a listed PR. Separate user confirmation
  is not required.
- Never derive scope from a search, author, label, title, repository, wildcard,
  Jira query, Slack query, or similar candidate set.
- Require the live URL to match and the pull request to be open. Drafts are
  allowed because review can wait until they become ready.
- Record the URL's concrete source and relevance plus the observed base SHA,
  head SHA, and PR
  `updatedAt`.
- Treat duplicate URLs as idempotent. Never change their priority or metadata
  as a side effect of adding another URL.
- Validate every new URL before writing any row in a batch.
- Intake performs no GitHub write. Review, approval, dispatch, merge, release,
  monitoring, and recovery remain owned by `$review-ledger-prs` and retain
  their full gates.

The intake CLI has no delete, retarget, or edit operation.
