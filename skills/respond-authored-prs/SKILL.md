---
name: respond-authored-prs
description: Respond to one pull request authored by the authenticated user whose ball is with the author (CI failed, conflicts, a reviewer responded, or no reviewer). Use when the queue starts a worker for an authored PR URL. Finish by handing the ball back to reviewers, or dispatch to the human when the needed change would drift from the PR description.
---

# Respond to an authored PR

You act for the PR author on exactly one PR URL given in the prompt. Do not touch
any other PR, and do not use the review ledger (`pull_requests.jsonl`).

## Done condition

The job is done only when the ball is with someone else:

- every reviewer is pending (yellow) again, or the PR is ready to merge, or
- you dispatched the PR to the human (see below).

The queue verifies this with a live re-check after you exit:

```sh
bun app/src/authored-prs.ts check <URL>
```

Run it yourself before exiting. `still-mine` means you are not done: keep going or dispatch.
Exiting without reaching the done condition is a failed attempt and is retried.

## Intent

The PR title and description are the intent. Read them first, then the diff.
Every change you make must stay inside that intent. Do not edit the description
to make a drifting change fit.

## Workspace

Work in a dedicated clone or worktree of the PR head branch under
`respond-workspaces/<owner>/<repo>-<number>` (gitignored). Never use the
read-only review checkouts under `repositories/`. Commit with the repository's
normal signing and push with a normal non-force push to the PR head branch. If
signing or authentication fails, stop and dispatch; never bypass it.

## What to do, by reason

`bun app/src/authored-prs.ts list --all | grep <URL>` shows the reason.

- `ci_failed`: read the failing check logs and fix the root cause. For policy
  checks (labels, milestones, PR metadata) apply what the check asks for when the
  repository's own rules determine the value; otherwise dispatch.
- `conflicting`: merge the base branch into the head branch and resolve keeping
  the PR's intent. If resolving requires choosing between behaviors, dispatch.
- `re_request`: a reviewer responded without an approval that counts. Handle
  every unresolved thread and review comment, then re-request review from those
  reviewers so they are pending again.
- `needs_reviewer`: nobody is pending and no approval counts. Request review from
  people who can approve: CODEOWNERS for the changed paths first, otherwise
  maintainers with push access evident from the repository. If you cannot
  determine anyone, dispatch.

## Judging review comments (including CodeRabbit and other bots)

Evaluate each comment on its merits against the intent and the code. Agreement is
not the default.

- Valid and within intent: fix it, reply with what changed (commit SHA), resolve.
- Wrong, out of scope, or already handled: reply with the concrete reason
  (code reference, test, or spec) and resolve. Declining is a normal outcome.
- Valid but outside the intent: do not implement; dispatch.

Write replies as plain technical statements. Never open with agreement or
apology ("おっしゃる通りです", "ご指摘ありがとうございます", "Great catch",
"You're right"). No praise, no hedging filler.

## Dispatch to the human

Dispatch instead of changing code when the needed change would drift from the PR
description (scope expansion, different approach, behavior change the
description does not promise), needs a product or business decision, or needs
access you do not have.

Phrase the decision as a closed question the human answers with one click on the
dashboard's decide tab: one question plus 2-4 concrete, mutually exclusive
options, each an action you can carry out as written (e.g. "Pin to a commit SHA",
"Keep the floating tag"). Do not add close/hold/retry; the page always offers them.

1. Send one Slack DM to `notify_slack_user` in `config/config.toml`: the full PR
   URL and the question, in Japanese, one line.
2. Record it so the queue stops retrying this head:

   ```sh
   bun app/src/authored-prs.ts dispatch <URL> --reason "<question>" --option "<A>" --option "<B>"
   ```

## Human decisions

Before anything else, run `bun app/src/authored-prs.ts decision <URL>`. If it
prints a decision for the current head, the human answered your earlier question:
carry out `choice` as the answer (it may be a free-text instruction instead of one
of your options) and do not dispatch the same question again.
`Retry` means retry with a fresh look; dispatch again only for a new question.

## Never

Force-push, rewrite history, merge, close, dismiss reviews, bypass branch
protection, mark a thread resolved without a reply, or act on another PR.
