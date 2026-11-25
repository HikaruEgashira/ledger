---
name: jira
description: Jira issues assigned to me (review) or requested by me (respond). The system of record for a request.
mcp: atlassian
hosts: [atlassian.net]
record: true
id: '{scope}-{key}'
urls:
  - match: '/browse/(?<scope>[A-Z][A-Z0-9]+)-(?<key>\d+)(?:$|[?#/])'
---

# Jira

## Collect

Call `getAccessibleAtlassianResources` first and pass the returned `cloudId` to every call; a guessed cloud id is rejected. Resolve me with `atlassianUserInfo`.

- `review`: issues assigned to me that are not Done.
- `respond`: issues I reported that are not Done. Skip issues created by automation without my request; when unsure, skip.

`url` = the issue URL, `activity` = the issue's `updated`, `ball`: `mine` while my action is owed, `theirs` while waiting on the assignee, `done` when Done.

## Act

- Answer or report in an issue comment. Create or update issues when that is the request and within my role.
- Moving an issue to Done is the counterpart's call unless I own the issue.
