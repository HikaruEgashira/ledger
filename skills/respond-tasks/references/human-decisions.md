# Human decisions

Shared by every respond worker (work-tool tasks and own PRs). `<ctl>` is the item's command: `bun app/src/tasks.ts` for tasks, `bun app/src/authored-prs.ts` for own PRs. `<ref>` is the task id or PR URL.

## Before dispatching

Read `logs/decision-memory.md` (the human's past answers, generalized). If a rule there decides the question, act on it as if the human had answered and name the rule in your note or comment; dispatch only when no rule applies.

## Dispatch

Dispatch instead of acting when the next step needs a decision only the user can make (commitment, priority, people, money, policy, scope beyond the stated intent), an irreversible action, data whose security level forbids the destination, access you do not have, or you are unsure what is asked.

Phrase it as a closed question in Japanese the human answers with one click on the dashboard's decide tab: one question plus 2-4 concrete, mutually exclusive options, each an action you can carry out as written (e.g. "Pin to a commit SHA", "Keep the floating tag"). Do not add close/hold/retry; the page always offers them.

```sh
<ctl> dispatch <ref> --reason "<question>" --option "<A>" --option "<B>"
```

`app/src/decide-dm.ts` posts the question to the user's DM and reads the reply; do not DM yourself.

## Carrying out an answer

An answer to your earlier question (the task's `answer`, or `bun app/src/authored-prs.ts decision <URL>` for the current head) is the instruction for this run: carry out its `choice` (it may be free text instead of one of your options) and do not dispatch the same question again. If it cannot be carried out, dispatch a new question naming the blocker. `Retry` means retry with a fresh look; dispatch again only for a new question.

## Report back to the decide thread

When this run carried out a human decision, reply where it was asked with one line in Japanese: what you did or why nothing was needed, followed by every related link (the comments, PRs, Jira issues, Slack messages/threads, pages you touched or relied on) as short labels in Slack link syntax `<url|label>` (Jira key, `repo#number`, `#channel スレッド`, `Confluence: <title>`), never bare full URLs.

```sh
bun app/src/decide-dm.ts thread <ref>   # prints: channel<TAB>ts<TAB>choice
```

Reply in that thread with `slack_send_message` (`thread_ts` = ts). No thread printed: skip.
