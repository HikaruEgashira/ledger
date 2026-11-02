# Delivery lifecycle

Merge is a transition, never completion.

```text
approved
  -> merged_waiting_release
  -> release_in_progress
  -> post_release_monitoring
  -> completed
                         \
                          -> recovering
                          -> recovered_monitoring
                          -> completed
```

## Required receipts

Write receipts under `delivery-artifacts/` and record each with
`deliveryctl.ts record <PR_URL> <PATH>`.

### Incorrect release path

The approved delivery plan remains immutable. If post-merge evidence proves
that its release path is incorrect, record one correction before any delivery
receipt exists:

```json
{
  "schema_version": 1,
  "url": "https://github.com/<org>/example/pull/123",
  "type": "delivery_plan_correction",
  "observed_at": "2026-07-24T04:30:00Z",
  "merge_sha": "40-hex SHA",
  "approval_base_sha": "40-hex SHA",
  "approval_head_sha": "40-hex SHA",
  "previous_delivery_plan_sha256": "64-hex SHA-256",
  "reason_code": "incorrect-release-path",
  "delivery_plan": {},
  "evidence": ["Concrete evidence for the actual release path"]
}
```

The replacement `delivery_plan` uses the same schema as review evidence. Run:

```bash
bun app/src/deliveryctl.ts replan \
  <PR_URL> delivery-artifacts/<owner>--<repo>--<number>-plan-correction.json
```

The command binds the correction to the exact ledger URL, approval refs, merge
SHA, previous plan digest, and correction artifact digest. It refuses a second
correction or any correction after a receipt. All later receipt validation and
completion use the corrected effective plan while preserving the approved plan.
The approved environment, monitoring requirements, recovery strategy, and
human-only boundaries remain fixed. Never use this path to weaken delivery
gates.

### Release

```json
{
  "schema_version": 1,
  "url": "https://github.com/<org>/example/pull/123",
  "type": "release",
  "observed_at": "2026-07-24T05:00:00Z",
  "merge_sha": "40-hex SHA",
  "status": "succeeded",
  "release_id": "12345",
  "release_attempt": 1,
  "release_identifier": "Deploy production",
  "release_url": "https://github.com/<org>/example/actions/runs/12345",
  "commit_sha": "40-hex SHA",
  "environment": "production",
  "evidence": ["Deploy job succeeded", "production revision is abcdef"]
}
```

Use `started`, `succeeded`, or `failed`, with a unique `observed_at` for every
receipt. A successful release needs an earlier matching `started` receipt with
the same release ID, attempt, identifier, environment, and commit. For
GitHub Actions, `release_id` is the numeric run ID, `release_attempt` is the
attempt number, and `release_identifier` exactly matches the frozen workflow
name. The recorder reads the real workflow run and verifies its status, URL,
workflow, attempt, and head SHA.

Never infer release success from merge or build success. Verify the deployed
revision and environment. Before recording success, refresh the local
repository so it contains both commits; the recorder runs
`git merge-base --is-ancestor <merge_sha> <commit_sha>` against that repository.
External releases use the same plan-bound identifier, environment, commit, URL,
and evidence fields, but omit `release_attempt`.

### Observation

```json
{
  "schema_version": 1,
  "url": "https://github.com/<org>/example/pull/123",
  "type": "observation",
  "observed_at": "2026-07-24T08:00:00Z",
  "merge_sha": "40-hex SHA",
  "phase": "post_release",
  "status": "healthy",
  "started_at": "2026-07-24T05:00:00Z",
  "ended_at": "2026-07-24T05:30:00Z",
  "log_source": "siem",
  "issues": [],
  "signals": [
    {
      "name": "error-rate",
      "source": "siem",
      "healthy": true,
      "evidence": "SIEM query and aggregate showing no release-correlated 5xx increase"
    }
  ]
}
```

Use phase `post_release` or `post_recovery`, and status `healthy` or
`degraded`. `log_source` and every signal `source` must be exactly `siem`.
Analyze one continuous SIEM interval of at least 30 minutes and at least the
plan's full observation window, whichever is longer. A healthy receipt requires
every planned signal to be healthy and `issues` to be empty. Any relevant
problem makes the receipt degraded and must be recorded in `issues`. The exact
planned signal set is required; timestamps must be ordered, after merge, and
not in the future. Direct production probes, production UI access, Datadog
queries, and infrastructure state are not observation evidence.

### Incident

```json
{
  "schema_version": 1,
  "url": "https://github.com/<org>/example/pull/123",
  "type": "incident",
  "observed_at": "2026-07-24T05:10:00Z",
  "merge_sha": "40-hex SHA",
  "severity": "SEV2",
  "impact": "Checkout errors increased for production users",
  "signals": ["5xx threshold breached"],
  "containment_actions": ["Stopped rollout"],
  "suspected_release": true
}
```

### Recovery

```json
{
  "schema_version": 1,
  "url": "https://github.com/<org>/example/pull/123",
  "type": "recovery",
  "observed_at": "2026-07-24T05:30:00Z",
  "merge_sha": "40-hex SHA",
  "strategy": "rollback",
  "status": "succeeded",
  "started_at": "2026-07-24T05:12:00Z",
  "completed_at": "2026-07-24T05:25:00Z",
  "actions": ["Rolled production back to the last known-good revision"],
  "verification": ["Previous revision is serving", "smoke checks pass"],
  "evidence": ["rollback run URL"]
}
```

Strategies are `rollback`, `feature-flag`, `hotfix`, `compatibility`, or
`redeploy`. A strategy differing from the review plan requires
`deviation_reason`.

### Forward-fix PR recovery

Prefer a forward fix over a revert when current evidence identifies a
correctable defect and reverting would discard valid changes or would not
address the root cause. Implementing and publishing the smallest root-cause
remediation needs no separate user confirmation. This standing authority does
not cover unrelated cleanup or any human-only recovery boundary.

1. Resolve the original ledger PR's author from live GitHub metadata. Do not
   infer it from commits, CODEOWNERS, or stale evidence.
2. Never push to, amend, or force-push the reviewed PR's head branch. Use a
   normal implementation checkout outside this review workspace, create a new
   branch, read the repository instructions, make the smallest root-cause fix,
   add a regression check, and run proportionate verification.
3. Create a signed commit and publish a separate remediation PR through the
   repository's normal authenticated non-force push path. Link the original PR
   and incident evidence, and request review from the original PR author. Stop
   on signing or authentication failure; never use an unsigned or alternate
   authentication fallback.
4. Keep the original delivery row in `recovering`. An open, approved, or merged
   remediation PR is not itself a successful recovery.
5. After the fix is released, record a `recovery` receipt with strategy
   `hotfix` or `compatibility`, include the remediation PR and release evidence,
   and set `deviation_reason` when it differs from the frozen plan.
6. Complete the full SIEM-only post-recovery window and postmortem before
   running the completion gate.

The remediation PR is outside the original ledger URL's action scope. Once its
exact live URL appears in current recovery evidence, add it through trusted
exact-URL intake without separate user confirmation. Addition only queues that
exact PR; once listed, never push to its head branch, and never review, approve,
or merge it before the normal gates pass.

### Postmortem

```json
{
  "schema_version": 1,
  "url": "https://github.com/<org>/example/pull/123",
  "type": "postmortem",
  "observed_at": "2026-07-25T03:00:00Z",
  "merge_sha": "40-hex SHA",
  "path_or_url": "docs/adr/0123-release-recovery.md",
  "root_cause": "Concrete root cause",
  "actions": ["Preventive action with owner or tracking link"]
}
```

## Completion gate

`deliveryctl.ts complete <PR_URL>` succeeds only when:

- the merge commit is known;
- the latest release event is a plan-bound success, has a matching start event,
  and its real commit contains the reviewed merge commit;
- the latest relevant observation is a full healthy SIEM-only post-release
  window of at least 30 minutes; or
- after a failed release, degraded observation, or incident, the latest
  recovery after the latest adverse event succeeded, the latest relevant
  observation is a full healthy SIEM-only post-recovery window of at least
  30 minutes, and a postmortem exists after the latest incident and recovery.

The gate evaluates the latest coherent chronological sequence. An old success
cannot mask a later failed/started release, degraded observation, incident, or
failed/started recovery.

For a genuinely non-releasing change, the reviewed plan must explicitly mark
release and recovery `not_applicable`; merge can then complete the lifecycle.

## Human-only recovery boundaries

The agent performs documented reversible actions. Dispatch only when recovery
requires irreversible data loss acceptance, legal/privacy/customer
notification, human-only production authentication, or an unresolved business
tradeoff. Continue containment and evidence collection while that decision is
pending.

Use only the fixed reason codes declared in the frozen plan:

- `irreversible-data-loss`
- `legal-privacy-customer-notification`
- `human-only-production-authentication`
- `unresolved-business-tradeoff`

Except for a production-authentication boundary, first record the incident,
impact, and containment. Then use the guarded, idempotent dispatch:

```bash
bun app/src/deliveryctl.ts dispatch \
  <PR_URL> --reviewer <LOGIN> --reason-code <CODE> \
  --detail "<single human decision needed>" --execute
```

If a dispatch write has an unknown outcome, verify externally that no matching
comment exists, then reconcile the exact dispatch before retrying:

```bash
bun app/src/deliveryctl.ts reconcile-dispatch \
  <PR_URL> --dispatch-sha256 <SHA256> \
  --evidence "<how the missing comment was verified>" --execute
```

Definitive HTTP 4xx and GraphQL mutation rejections are recorded as rejected,
not unknown, and can be retried after correcting the authentication path.
