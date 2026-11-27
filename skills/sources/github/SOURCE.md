---
name: github
description: GitHub PR review requests for watched people. Mine belong to the PR ledgers.
mcp: gh
hosts: [github.com]
id: '{scope}#{key}'
urls:
  - match: 'github\.com/(?<scope>[^/]+/[^/]+)/pull/(?<key>\d+)'
---

# GitHub

## Collect

Me: nothing (my review requests and PRs belong to the PR ledgers). A person's `id` is their GitHub login. List only requests to them as an individual (team requests excluded, as for me):

```sh
bun app/src/review-requests.ts direct <id>
```

One task per PR: `axis: "review"`, `url` = PR URL, `activity` = `updatedAt`, `counterpart` = author login, `ball: "mine"`. A PR no longer listed is not emitted; it stays until its next activity.

## Act

Never review, comment or approve as the watched person. Dispatch for the human to relay.
