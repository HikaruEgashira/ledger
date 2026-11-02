# Ledger intake schema

`pull_requests.jsonl` contains one JSON object per in-scope PR. Trusted sync or
exact-URL intake, separate from direct ledger editing, adds rows in this minimal
form:

```json
{
  "schema_version": 1,
  "repository": "example-org/example",
  "pr_number": 123,
  "url": "https://github.com/<org>/example/pull/123",
  "status": "queued",
  "priority": 50,
  "added_at": "2026-07-24T04:00:00Z"
}
```

The URL, repository, and PR number must agree; only `<org>` URLs are accepted.
Priority ranges from 0 through 100, with lower values processed first. URLs
must be unique.

The review CLI owns all other fields, including `live`, `last_synced_at`,
`evidence_path`, `evidence_sha256`, `decision`, `approval`, and `last_error`.
Intake must not pre-populate review evidence or approval state. Review agents
must not add, delete, or retarget rows.

The trusted direct-request sync adds only open <org> PRs whose live
`reviewRequests` contains the authenticated login as a `User`. It records:

```json
{
  "intake": {
    "mode": "direct-personal-review-request",
    "reason": "GitHub directly requested review from example",
    "observed_at": "2026-07-24T04:00:00Z",
    "base_sha": "40-hex SHA",
    "head_sha": "40-hex SHA",
    "pr_updated_at": "2026-07-24T03:59:55Z"
  },
  "review_request": {
    "active": true,
    "reviewer": "example",
    "observed_at": "2026-07-24T04:00:00Z",
    "base_sha": "40-hex SHA",
    "head_sha": "40-hex SHA",
    "pr_updated_at": "2026-07-24T03:59:55Z"
  }
}
```

The search must complete below its limit and every candidate detail and new-row
live validation must succeed before direct-request rows are written. Team-only
and CODEOWNERS-only requests are excluded. When a direct request is removed,
sync sets `review_request.active` to `false` but retains the action-scope row.

The same sync also adds open <org> PRs whose `latestReviews` shows the
authenticated login's latest review as `DISMISSED` (stale after a push), so
reviews posted outside the ledger still get re-reviewed. These rows use
`intake.mode: "dismissed-own-review"` and carry no `review_request`.

The workspace's trusted exact-URL intake is `$add-review-ledger-prs`. It accepts
a live-verified exact URL already present in the current task context or in
live evidence from a listed PR, without separate user confirmation, and
records:

```json
{
  "intake": {
    "mode": "trusted-exact-url",
    "reason": "Concise source and relevance of the exact URL",
    "observed_at": "2026-07-24T04:00:00Z",
    "base_sha": "40-hex SHA",
    "head_sha": "40-hex SHA",
    "pr_updated_at": "2026-07-24T03:59:55Z"
  }
}
```

Automated intake adds optional `intake.source` (e.g. `review-poller`) and
`intake.scope` (a `[[scopes]]` name in `config/config.toml`); consumers must key on
these, not on `reason` text.

Existing `manual-explicit-url` records remain valid history. Exact-URL intake
does not edit, delete, reprioritize, or retarget existing rows.

The `approval` record binds the GitHub review to an exact commit and freezes
the delivery plan and its SHA-256 digest. `approved` is reached only after the
same base/head are refreshed and review threads are verified after the approval
timestamp.

The `withdrawal` record binds a user-authorized correction to the exact current
base SHA, head SHA, and REST review ID stored in the row's confirmed
`change_request`. It is confirmed only after GitHub returns `DISMISSED` and the
same dismissed review is observed through the pull-request review list. The
original `change_request` remains as audit history with `verification:
"withdrawn"`; its evidence pointers are cleared so the current refs must be
reviewed again.

After merge, the CLI advances the row through
`merged_waiting_release`, `release_in_progress`, `post_release_monitoring`,
`recovering`, `recovered_monitoring`, and finally `completed`. The `delivery`
field contains the merge identity and SHA-256-bound lifecycle receipt ledger.
