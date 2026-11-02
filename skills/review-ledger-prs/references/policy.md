# Approval and dispatch policy

## Approval gate

Approve only when all conditions are true immediately before the write:

1. The exact PR URL is present in `pull_requests.jsonl`.
2. The PR is open, non-draft, and not conflicting.
3. Live base and head SHAs equal the SHAs in the completed evidence artifact.
4. The exact diff, affected callers, tests, and security impact were reviewed.
5. Proportionate local verification passed or is explicitly not applicable with
   a concrete reason.
6. Required CI has no pending or failed result.
7. Unresolved review threads are verified as zero using the gh cli.
8. No active `CHANGES_REQUESTED` review remains. The agent's own confirmed
   change request bound to an older head is satisfied, not active, when the
   completed evidence approves the exact current head; same-head, unverified,
   or others' change requests remain active.
9. No unresolved Critical, High, or Medium finding remains.
10. A concrete release, monitoring, and reversible recovery plan is recorded,
    or the change is explicitly proven non-releasing.
11. No human-only condition below applies.

Any unknown is a closed gate, not evidence of safety.

## Correcting an erroneous agent review

Withdraw an agent-authored `CHANGES_REQUESTED` review only when the user
explicitly directs the correction after the claimed blocker is disproven. Use
the guarded ledger command; never use a raw dismissal. It must bind the exact
ledger URL, current base and head SHAs, and the REST ID of the row's current
confirmed change request. A GitHub `DISMISSED` response and a live pull-request
review read must both confirm that exact review.

A confirmed withdrawal invalidates the obsolete evidence and returns the
current refs to review. It is not an approval and does not waive failed or
pending CI, unresolved threads, active reviews from others, stale refs, or any
other approval gate.

## Agent-owned outcomes

The agent must handle these without human dispatch:

- code defects, vulnerabilities, missing tests, or maintainability findings;
- failing, flaky, missing, or still-running CI that can be inspected;
- unresolved review comments or a changed head SHA;
- large or cross-cutting diffs;
- unfamiliar code, low confidence, or need for additional investigation;
- fixable merge conflicts or an out-of-date branch;
- a need to request concrete changes from the author.

The outcome is `changes_requested`, `wait_ci`, or continued `review`.

## Human-only outcomes

`human_required` is allowed only with one of these reason codes:

- `required-human-identity`: GitHub policy, CODEOWNERS, separation of duties, or
  author identity requires a designated human approval that the agent cannot
  legally or technically satisfy.
- `business-risk-acceptance`: approval requires an accountable business,
  legal, privacy, financial, production-access, or irreversible-migration risk
  acceptance not encoded in repository policy.
- `unavailable-evidence`: decisive evidence is inaccessible to the agent after
  all safe read paths are exhausted, such as a human-only external system or
  encrypted production result.
- `ambiguous-intent`: two materially different product or security outcomes are
  both plausible and repository evidence cannot determine the intended one.
- `incident-coordination`: a suspected security incident requires authorized
  human coordination, notification, or containment outside the PR workflow.

Difficulty, PR size, time pressure, tool inconvenience, and "a human would be
safer" are not valid reason codes.

Known failed/pending CI, unresolved threads, stale thread evidence, and open
blocking findings must be handled before `required-human-identity` or
`business-risk-acceptance` dispatch. `incident-coordination` may dispatch
immediately while the agent continues containment.

## Dispatch payload

Send one compact dispatch containing:

- PR URL and reviewed head SHA;
- allowed reason code;
- the single decision or inaccessible evidence needed;
- completed checks and review evidence;
- the narrowest responsible person or CODEOWNER.

Do not broadcast and do not ask the human to repeat the agent's completed review.

## Delivery completion

Approval and merge are intermediate states. Completion requires:

- verified release of the reviewed merge SHA to the intended environment;
- a continuous SIEM-log analysis interval of at least 30 minutes and at least
  the frozen plan's monitoring window, whichever is longer;
- every planned signal supported by SIEM evidence, with no relevant problem in
  that interval;
- if an incident occurred, successful reversible recovery, a complete
  SIEM-only post-recovery monitoring window, and a postmortem;
- tamper-evident receipts recorded in the ledger.

SIEM is the only release-monitoring log source. Direct production endpoint/UI
access, Datadog queries, and production infrastructure inspection are not
monitoring evidence and must not be used to declare the phase healthy.

The agent owns release observation, routine rollback/redeploy, feature-flag
containment, hotfix delivery, and recovery verification. Human dispatch during
recovery is limited to irreversible data-loss acceptance, legal/privacy or
customer notification, human-only production authentication, and unresolved
business tradeoffs.

When verified recovery evidence makes a forward-fix PR safer than a revert,
implement and publish the smallest root-cause remediation without separate user
confirmation. Never push to, amend, or force-push the reviewed PR's head
branch. Use a new branch and separate PR from a normal implementation checkout
outside this review workspace, with a signed commit and the repository's normal
authenticated non-force push path. Stop on signing or authentication failure;
do not bypass either requirement. Request review from the live author of the
original ledger PR. Add the new exact URL through trusted exact-URL intake.
Addition only places it in action scope; do not mark recovery successful until
that PR's fix is merged, released, and verified.

The corresponding post-merge reason codes are exactly:

- `irreversible-data-loss`
- `legal-privacy-customer-notification`
- `human-only-production-authentication`
- `unresolved-business-tradeoff`

The reason must already be declared in the frozen delivery plan. Except for
human-only production authentication, record the adverse event, impact, and
containment before dispatch. A PR comment is the single post-merge dispatch;
do not broadcast it elsewhere.
