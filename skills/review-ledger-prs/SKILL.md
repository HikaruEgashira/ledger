---
name: review-ledger-prs
description: Strictly review, approve, request changes on, withdraw an erroneous current change request, minimally dispatch, and operate the full merge-to-release lifecycle for <org> pull requests listed in this workspace's pull_requests.jsonl ledger. Use whenever an agent processes the review queue, corrects its current review, re-reviews a changed PR, monitors CI or review transitions, follows a merge into release, performs post-release health monitoring, recovers a regression, closes the delivery with verified receipts, or keeps recurring ledger monitoring alive in the current Codex session with a sleep interval.
---

# Review ledger PRs

Keep `pull_requests.jsonl` as the sole action-scope boundary. Read
[references/policy.md](references/policy.md) before making a decision and
[references/artifact-schema.md](references/artifact-schema.md) before writing
evidence. Read [references/ledger-schema.md](references/ledger-schema.md) only
when validating the trusted intake format; review agents never edit scope
directly and may add an exact URL only through trusted intake. Read
[references/delivery-lifecycle.md](references/delivery-lifecycle.md) before
acting on a merged PR. Merge is not a completion state.

This is a review-only workspace. Never push commits, branches, tags, or other
code/ref changes to a remote repository, including for a listed pull request.
Do not run `git push` or an equivalent remote-code mutation. Guarded,
ledger-scoped review metadata writes remain allowed.

When verified recovery evidence requires a code or configuration change, never
push to, amend, or force-push the reviewed PR's head branch. Without separate
user confirmation, use a normal implementation checkout outside this review
workspace to create a new branch and a separate forward-fix PR containing the
smallest root-cause remediation. Use a signed commit and the repository's
normal authenticated non-force push path; stop rather than bypass signing or
authentication failure. Add the exact remediation PR URL through
`$add-review-ledger-prs`. Intake only queues the PR; after listing, its head
branch is read-only to this review workflow and every review and approval gate
still applies.

## Parallel execution

Use subagents for actionable ledger work. The coordinator validates and
synchronizes the ledger, then assigns each independent changed, newly eligible,
or newly due PR URL to one subagent. Fill available slots while actionable rows
remain; an unchanged row with the same recorded blocker is not work to repeat.

Name each subagent `<owner>_<repo>_pr_<number>_<phase>`, normalized to lowercase
letters, digits, and underscores (for example,
`c_fo_siem_jiro_pr_115_review`), so its repository, PR, and current phase are
visible in the agent list.

Each subagent owns one exact ledger URL end to end for its current phase. For a
review phase, the same subagent must inspect the diff, verify CI and threads,
write the evidence artifact, run `record` and `gate`, perform the guarded
decision action, and verify the live result. The coordinator must not take over
a PR's gate or guarded action merely because the subagent has finished the
investigation. For a delivery phase, assign each independent merged PR to one
subagent through release identification, receipts, observation, recovery when
needed, and completion.

Never assign the same PR phase to multiple subagents. A head or base change
invalidates the worker's evidence and requires a fresh review of the new refs.
The ledger lock serializes shared ledger writes; review, CI inspection,
thread inspection, repository verification, and independent guarded actions
remain parallel. After workers finish, the coordinator re-validates and
re-synchronizes the ledger and reports the aggregated result.

## Review responsibility boundary

When CodeRabbit is configured for the repository:

- Treat CodeRabbit as the primary owner of fine-grained code-quality, style,
  naming, small-refactor, and routine maintainability feedback. Do not duplicate
  equivalent nitpicks or make them independent approval blockers.
- Verify that CodeRabbit ran against the current head and that its current-head
  findings are resolved. A green check alone does not close unresolved review
  threads; inspect the thread state separately.
- Keep agent ownership of runtime correctness, security and authorization
  impact, data-loss risk, test and CI evidence, cross-component behavior, and
  release and recovery safety. Do not delegate these gates to CodeRabbit.
- When a static concern is disputed or the user asks for execution evidence,
  run the real local code path with controlled inputs. If the behavior works
  and current-head CodeRabbit findings are resolved, withdraw the concern and
  do not retain it as an approval blocker. If it fails, report the concrete
  runtime impact rather than a stylistic or theoretical objection.
- Do not require the author to add a test merely to preserve a behavior that
  the agent can execute directly. Representative execution of the real
  affected path is sufficient review evidence when it passes. Request a new
  test only when repository policy or required CI explicitly requires it, or
  when the claimed fix cannot be safely verified through actual execution.
- Avoid review drip after the author addresses requested changes. Re-review the
  requested fixes and regressions directly introduced by the new commits; do
  not turn pre-existing behavior, outside-diff cleanup, optional hardening,
  unexecuted hypotheses, or missing extra tests into new blockers. Add a new
  blocker only for a confirmed material runtime, security/authorization,
  data-loss, or required-CI regression introduced by the changed head.
- Validate functional or security impact before sending `request-changes`.
  A confirmed same-head change request is sticky: `approve` cannot
  supersede it while GitHub still reports `CHANGES_REQUESTED` on that head.
  Once the author pushes a new head and fresh evidence approves it, the older-head
  request counts as satisfied and `approve` may proceed. Do not create that state for CodeRabbit-owned feedback,
  and never bypass it with an unguarded dismissal or raw review write.
- A failed or pending CI check blocks approval but is not by itself a change
  request. When the completed review finds no author code change is needed,
  keep the row at `wait_ci`; never send `request-changes` merely to restate CI.

This boundary never waives stale-ref checks, failed or pending required CI,
unresolved current threads, active changes requested, reproducible functional
or security findings, or any other approval gate in the policy.

## Review reporting

Report one concise disposition line, followed only by what still blocks
approval. Label each remaining item as `code change required`, `CI failed`,
`CI pending`, or `thread action required`. Omit resolved or disproven findings,
CodeRabbit-owned fine-grained feedback, and requests to add tests when direct
execution already passed. Do not repeat review history merely to show work.

## 重要アクションのDM通知

Guarded approval、changes request、withdrawal、human dispatch、release/recovery
receipt、または completion の結果は、完了をライブで確認した直後に、ユーザー本人
（`config/config.toml` の `notify_slack_user`）へSlack DMで1行だけ通知する。必ず対象PRの完全なURLを含め、
日本語で結果と次に必要な作業だけを書く。経緯、ツール出力、挨拶、複数行の要約は
書かない。状態が変わらない監視結果や、まだ実行していない判断はDM対象外とする
（保留判断は下の「保留判断のDM通知」に従う）。

DMの対象URLと動詞は、同じライブ実行の検証済みreceiptから取得する。別PRの
直前コンテキストやdelegation要約から補完しない。receiptが対象URL、実行済みaction、
確認結果をすべて示さない場合はDMを送らない。

例: `https://github.com/<org>/example/pull/123 を承認しました。CI成功・未解決コメントなしを確認済みです。`

### 保留判断のDM通知

承認も変更依頼も出さず、他PRのapply・merge待ちなど作者以外の対応を待つ保留
（`wait_ci` を含む）と新たに判断したときも、判断を記録した直後に同じ宛先へ1行
DMする。対象PRと待ち先PRの完全なURL、保留理由、再開条件だけを日本語で書く。
同じ保留理由が続くだけの再確認は、新しい証拠が出るまでDM対象外とする。

例: `https://github.com/<org>/example/pull/123 は指摘解消済みですが、https://github.com/<org>/example/pull/124 のapply待ちでplanが失敗しているため承認を保留中です。124のmerge・apply後に再確認します。`

## Author-facing review messages

Write every author-facing review message and change request in clear Japanese.
Focus only on the concrete action the author needs to take, or—when approving—the
specific evidence that supports LGTM.

Follow the `communication` skill's voice (load it when available): conclusion
first, 1–3 sentences, です／ます with light endings (「〜じゃないでしょうか？」
「大丈夫そうです」「LGTMです！」), full-width （） and ！, at most 2–3 bullets,
no headings or templated structure, no AI-styled polished prose.

- Start with the target and the requested change, for example:
  `src/example.ts の認可チェックを、操作対象の所有者も検証する形に変更してください。`
- Add a short reason only when it is necessary to make the requested action
  unambiguous or to prevent an unsafe fix.
- Do not include greetings, review history, tool output, status summaries,
  speculative alternatives, or praise.
- When several independent changes are required, use one short bullet per
  action. Each bullet must be independently actionable.
- For an approval, write only the facts that support LGTM. Put the exact change
  and why it is safe in the first Japanese sentence of `notes`; name the actual
  local verification in `coverage.test_evidence`. The guarded approval renders
  those facts without labels, CI status, or review-comment counts:

  ```markdown
  LGTMです。
  - <notesの先頭文>
  - <実行済み検証>
  ```

  When every gate was decided by deterministic checks alone, set
  `"deterministic": true` in the artifact; the approval body is then exactly
  `LGTM!` with no reasoning.

  Do not use a generic approval sentence, add a separate status comment, or
  repeat review history.
- Do not post a separate review comment when no author code change is requested
  (for example, while only waiting for CI).

## Process the queue

1. Validate the current ledger, run direct-request sync first, validate the
   resulting unified ledger, and only then select work:

   ```bash
   bun app/src/reviewctl/cli.ts validate
   bun app/src/review-requests.ts sync
   bun app/src/reviewctl/cli.ts validate
   GHTKN_APP=<org>/write bun app/src/reviewctl/cli.ts auto-review --execute
   bun app/src/reviewctl/cli.ts next --summary
   ```

   `auto-review` approves only PRs fully covered by a rule in
   `config/deterministic-review.json` (repository, path globs, size) with zero
   unresolved threads, through the same guarded `record`/`approve` gates. Do
   not assign rows it handled; never add rules on your own.

   Assign every row listed by `next --summary` (check its `TOTAL` line) to a
   subagent; never act on only the first row of the raw `next` output.

   `review-requests sync` batches candidate metadata through GraphQL,
   verifies direct `User` requests, adds newly scoped rows, and refreshes
   existing rows. If it fails, do not run `next` against incomplete state.

2. For each selected PR, verify its live base and head SHAs. Work only on the
   ledger URL. Read repository content from `repositories/<owner>/<repo>`; if
   absent, create an authenticated local checkout with standard Git tooling.

3. Review the exact `baseRefOid...headRefOid` diff in an isolated checkout.
   Use a standard Git worktree. Read all repository instructions, inspect
   callers and tests, run proportionate tests and linters, and perform a
   security diff review. Do not infer safety from file count, author, labels,
   prior approvals, or green CI.

4. Capture the PR's `updatedAt`, then verify unresolved review threads with
   `gh api graphql` (`reviewThreads { nodes { isResolved } }`) and record
   `method: "gh"`. Record both timestamps. A changed
   `updatedAt` or unknown thread count blocks approval.

5. Before approval, identify the real release path, monitoring signals/window,
   rollback or other recovery path, and true human-only recovery boundaries.
   Include this delivery plan in the evidence artifact.

6. Write one JSON evidence artifact under `review-artifacts/`, then record it:

   ```bash
   bun app/src/reviewctl/cli.ts record \
     <PR_URL> review-artifacts/<owner>--<repo>--<number>.json
   bun app/src/reviewctl/cli.ts gate <PR_URL>
   ```

   `record` freezes a read-only copy under `review-artifacts/records/` and the
   ledger points there, so rewriting the working file later is safe.

## Act on the decision

- `approve`: immediately run the guarded command below. It re-syncs live state,
  refuses stale evidence, writes the review against the exact head
  `commit_id`, and leaves the row in
  `approval_pending_verification`.

  ```bash
  GHTKN_APP=<org>/write bun app/src/reviewctl/cli.ts approve \
    <PR_URL> --execute
  ```

  Then capture the new `updatedAt`, re-check review threads after the approval
  timestamp, update the same evidence artifact without changing the frozen
  delivery plan, and run `record` again. The original base and head must still
  match. Only the resulting `approved` action completes approval verification.
  The guard uses `gh api` only for this commit-bound mutation; it never uses it
  to retrieve repository content.

- `changes_requested`: write a concise Markdown review under
  `review-artifacts/`, then use the guarded command. It enforces ledger scope
  and a fresh SHA before writing.

  ```bash
  GHTKN_APP=<org>/write bun app/src/reviewctl/cli.ts request-changes \
    <PR_URL> review-artifacts/<owner>--<repo>--<number>-changes.md --execute
  ```

  Keep ownership with the agent, monitor for a new head, and re-review.
  A confirmed change request remains current while its base and head remain
  unchanged; do not refresh or resend it merely because its evidence aged.

- When the user explicitly directs you to withdraw an erroneous change request
  after its blocking finding is disproven, use only the guarded command below.
  Bind the exact current base, head, and REST review ID printed by the ledger.
  Run it without `--execute` first and inspect the exact target. The executed
  command accepts only the row's current confirmed change request, requires
  GitHub to return that review as `DISMISSED`, verifies the dismissed review
  through `gh pr view`, and invalidates the obsolete review evidence. Withdrawal
  is not approval; re-review the current refs and retain all CI and thread gates.

  ```bash
  GHTKN_APP=<org>/write bun app/src/reviewctl/cli.ts withdraw \
    <PR_URL> --review-id <REST_REVIEW_ID> \
    --base-sha <BASE_SHA> --head-sha <HEAD_SHA> \
    --message "<concise correction>" --execute
  ```

- `review`, `wait_ci`, or `wait`: continue investigation or monitoring. These
  are not human-dispatch reasons.

- If a guarded review write has an unknown outcome, verify externally that no
  matching review was created, then reconcile the exact current-ref attempt
  before retrying:

  ```bash
  bun app/src/reviewctl/cli.ts reconcile \
    <PR_URL> --action <approve|request-changes> \
    --evidence "<how the missing write was verified>" --execute
  ```

  HTTP 4xx rejection responses other than 408 are recorded as rejected writes,
  not unknown outcomes, and do not require reconciliation.

- A row stuck in `error` with "evidence artifact changed after it was recorded"
  or "verified approval evidence cannot be changed" (confirmed approval, refs
  unchanged): never rewrite frozen evidence or edit the ledger. Run the guarded
  recovery without `--execute` first, then with it. If the approval is still
  live it rebinds the digest to the freshly verified artifact; if GitHub
  dismissed it, it resets the approval so `approve --execute` can re-approve.
  Changed refs need a normal re-review instead.

  ```bash
  bun app/src/reviewctl/cli.ts recover \
    <PR_URL> review-artifacts/<owner>--<repo>--<number>.json \
    --reviewer <APPROVER_LOGIN> --evidence "<why the artifact changed>" [--execute]
  ```

- `human_required`: dispatch once to the narrowest known responsible human with
  the guarded command. It refuses dispatch while known agent-owned work remains
  and records the recipient and delivery.

  ```bash
  GHTKN_APP=<org>/write bun app/src/reviewctl/cli.ts dispatch \
    <PR_URL> --reviewer <LOGIN> --execute
  ```

## Follow merge through release

For every `merged_waiting_release` row:

1. Verify the merge SHA and load the reviewed delivery plan.
   If evidence proves that the frozen release path is incorrect, use the
   auditable `deliveryctl.py replan` flow in
   [references/delivery-lifecycle.md](references/delivery-lifecycle.md) before
   recording any receipt. Never edit the approved plan or ledger directly.
2. Observe or trigger the repository-defined release path. Do not equate merge,
   artifact build, or workflow start with release success.
3. Refresh the local repository, then record `started` and final release
   receipts with the real release identity, deployed revision, and environment.
   For GitHub Actions, the recorder reads the actual workflow run. On success,
   it also proves locally that the deployed commit contains the merge SHA.
4. On success, enter the release-monitoring phase. Use SIEM logs as the only
   monitoring evidence source: do not probe production endpoints, open the
   production UI, query SIEM directly, or use production infrastructure
   state as monitoring evidence. Analyze one continuous interval of at least
   30 minutes and at least the frozen plan's `window_minutes`, whichever is
   longer. Record `healthy` only when every planned signal has SIEM evidence
   and the analyzed interval contains no relevant problem; otherwise record
   `degraded` with the detected issues.
5. On degradation, apply `incident-handling`: establish impact/severity from
   SIEM evidence,
   contain, choose the pre-reviewed reversible recovery, execute it, and record
   incident and recovery receipts. After recovery, monitor the full
   post-recovery window using SIEM only and record a postmortem.
   When a forward fix is safer than a revert, follow the forward-fix PR flow in
   [references/delivery-lifecycle.md](references/delivery-lifecycle.md). Keep
   the original delivery row in `recovering` until the fix is merged, released,
   and verified; an open PR is not a successful recovery receipt.
6. Run the completion gate only after all receipts exist:

   ```bash
   uv run skills/review-ledger-prs/scripts/deliveryctl.py complete <PR_URL>
   ```

Use `deliveryctl.py record` for every receipt described in
`references/delivery-lifecycle.md`. Dispatch a human only for the recovery
boundaries in that reference, using `deliveryctl.py dispatch`; continue safe
containment and evidence collection while waiting.

## Monitor continuously

Run one pass from each recurring automation tick:

```bash
bun app/src/reviewctl/cli.ts monitor --once
uv run skills/review-ledger-prs/scripts/deliveryctl.py due --auto
```

`due --auto` completes `not_applicable` deliveries, records GitHub Actions
release receipts from the frozen workflow, and prints a deterministic blocker
only when it first appears or changes. Only printed rows are agent work.

Process every emitted `BASE_CHANGED`, `HEAD_CHANGED`, `PR_UPDATED`,
`CI_PENDING`, `CI_FAILED`, `CI_INVALIDATED_DECISION`,
`REVIEW_INVALIDATED_DECISION`, `CHANGES_REQUESTED`, `APPROVAL_CANDIDATE`,
`MERGED`, `CLOSED`, or `SYNC_FAILED` event in the same run. `SYNC_UNAVAILABLE`
is a workspace-wide credential or network outage: do not start per-PR work;
ask the user to restore access (e.g. `ghtkn agent unlock`) and wait. The monitor emits it once per distinct outage and re-probes every 10 minutes, so silence means the outage persists. A
`SYNC_FAILED` is emitted once per new error, so silence means no new work.
Never expose deterministic gate or classification logic in author-facing
review messages. For `due`, dispatch
only rows whose monitoring window has newly elapsed or whose release, recovery,
or prior blocker has new evidence; retain an unchanged row without a write or
repeat investigation. A monitor reports transitions only; the agent performs
the required review, release, observation, and recovery. Do not start a second
persistent monitor when one already exists.
