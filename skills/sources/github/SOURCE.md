---
name: github
description: GitHub PR review requests for watched people (task_people). My own PRs belong to the PR ledgers, not here.
mcp: gh
hosts: [github.com]
id: '{scope}#{key}'
urls:
  - match: 'github\.com/(?<scope>[^/]+/[^/]+)/pull/(?<key>\d+)'
---

# GitHub

## Collect

Only for people in the prompt's `People` with a `github` login; with none, emit nothing. Use the `gh` CLI (`GHTKN_APP` read app), never MCP:

```sh
gh search prs --review-requested=<github> --state open --json url,title,author,updatedAt --limit 100
```

One task per PR: `axis: "review"`, `for: <person name>`, `url` = PR URL, `activity` = `updatedAt`, `counterpart` = author login, `ball: "mine"`. A PR no longer listed is not emitted; it stays until its next activity.

## Act

Never review, comment or approve as the watched person. Dispatch for the human to relay.
