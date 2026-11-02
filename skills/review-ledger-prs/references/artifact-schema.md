# Review evidence artifact

Store one JSON object per PR under `review-artifacts/`.

```json
{
  "schema_version": 1,
  "url": "https://github.com/<org>/example/pull/123",
  "base_sha": "40-hex-character SHA",
  "head_sha": "40-hex-character SHA",
  "reviewed_at": "2026-07-24T04:00:00Z",
  "verdict": "approve",
  "coverage": {
    "diff": "pass",
    "security": "pass",
    "tests": "pass",
    "test_evidence": ["project verification command: pass"],
    "tests_not_applicable_reason": null
  },
  "review_threads": {
    "unresolved": 0,
    "verified_at": "2026-07-24T04:00:00Z",
    "method": "gh",
    "pr_updated_at": "2026-07-24T03:59:55Z"
  },
  "findings": [
    {
      "severity": "low",
      "status": "open",
      "summary": "Non-blocking observation",
      "location": "src/example.ts:10"
    }
  ],
  "human_dispatch": {
    "required": false,
    "reason_code": null,
    "detail": null
  },
  "delivery": {
    "release": {
      "mode": "github-actions",
      "identifier": "Deploy production",
      "environment": "production",
      "reason": null
    },
    "monitoring": {
      "window_minutes": 30,
      "signals": [
        {
          "name": "error-rate",
          "source": "siem",
          "healthy_when": "5xx remains below the established baseline threshold",
          "failure_when": "5xx breaches the release threshold"
        }
      ]
    },
    "recovery": {
      "preferred_strategy": "rollback",
      "procedure": ["Run the repository-defined production rollback workflow"],
      "verification": ["Previous revision is serving and smoke checks pass"],
      "human_boundaries": ["irreversible-data-loss"]
    }
  },
  "notes": "Optional concise review notes"
}
```

Allowed verdicts are `approve`, `changes_requested`, and `human_required`.
Diff and security coverage may be `pass` or `incomplete`; `approve` requires
both to be `pass`. Tests may be `pass`, `not_applicable`, or `incomplete`;
`not_applicable` requires a concrete reason. Findings use Critical, High,
Medium, or Low severity and `open` or `resolved` status.

For `human_required`, set `human_dispatch.required` to `true` and use exactly
one reason code from the policy. For `approve`, it must be `false`, all blocking
findings must be resolved, and review-thread verification must be current.
Capture the PR's `updatedAt` immediately before checking threads, store it as
`pr_updated_at`, then verify threads. The final live refresh must still have the
same value. When review threads are the unavailable evidence, use
`unresolved: null`, `verified_at: null`, `pr_updated_at: null`, and
`method: "unavailable"`; this is valid only with `human_required`.

The delivery plan is mandatory before approval. `mode: "not_applicable"`
requires a concrete release reason, no signals, and
`preferred_strategy: "not_applicable"` with empty procedure/verification lists.
Otherwise, identify the real release path, a monitoring window of at least 30
minutes, every health/failure signal available from SIEM, and a reversible
recovery procedure. Use exactly `siem` as every monitoring signal's `source`.
Release monitoring must not depend on direct production access, Datadog, or
another log source.

For `github-actions`, `delivery.release.identifier` is the exact workflow name
reported by `gh run view --json workflowName`. Monitoring signal names must be
unique. `human_boundaries` accepts only these fixed reason codes:

- `irreversible-data-loss`
- `legal-privacy-customer-notification`
- `human-only-production-authentication`
- `unresolved-business-tradeoff`

Use an empty list when none applies. A `not_applicable` delivery has no
monitoring signals, recovery steps, verification steps, or human boundaries.

Run `reviewctl record` after writing the artifact. It records the artifact's
SHA-256 digest in the ledger; later modification invalidates the approval gate.
The delivery plan is frozen at the commit-bound approval write. The
post-approval artifact may refresh timestamps and thread evidence, but cannot
change that plan. Once approval confirmation succeeds, its full evidence
artifact is immutable for those base and head SHAs.
