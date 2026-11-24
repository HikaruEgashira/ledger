---
name: decide-dm
description: Post pending human decisions (own-PR and Slack/Jira task questions) to the user's Slack DM and turn the user's thread replies into decisions. Use when `bun app/src/decide-dm.ts sync` starts a run with a plan.
---

# Decide over Slack DM

The DM to the user is for decisions only. Post nothing else there.

The prompt gives the DM user id and a plan: `post` (new questions), `watch` (questions already posted, with `channel` and `ts`), `update` (posted questions whose source changed) and `remind` (posted questions left unanswered too long).

## Post

For each `post` item, collect every link related to it first: the item `url`, and the PRs, Jira issues, Slack threads, Confluence/Docs pages and other URLs that the item, its task record (`bun app/src/tasks.ts show <ref>` for tasks: `summary`, `note`) and its source (PR description, Jira description and comments, Slack thread) point to. Then send one message to the DM user with `slack_send_message`:

```
**<title>**
<question>
1. <option 1>
2. <option 2>
...
関連: <url|PSIRT-21302> / <url|aws-infra#69513> / <url|#ask-security スレッド> / <url|Confluence: ページ名>
返信: 番号 か 自由記述（このスレッドに）
```

The first line is the title in bold (`**...**`, the send tool converts it), with no prefix. Links are always short labels, never bare full URLs (Slack link syntax `<url|label>`): Jira key, `repo#number` for PRs, `#channel スレッド` for Slack threads, `Confluence: <title>` / `Docs: <title>` for pages. Put the item's own link first; no duplicates.

Then record it with the returned channel and ts:

```sh
bun app/src/decide-dm.ts posted '<key>' <channel> <ts>
```

## Watch

Find replies with one search, not one read per item (Slack rate limits): `slack_search_public_and_private` with `from:<@DM user> after:<date of the oldest watch at>`, `channel_types: im`, `sort: timestamp`. Only for watch items whose `ts` is the thread of a hit, read that thread (`slack_read_thread` with `channel`, `ts`). Consider only replies written by the DM user, after the post, and newer than `handled` (ignore bot and app messages). Take the latest one and decide what it is:

- **An answer** (an option number, an option's text, or an instruction to act): record it, then add a `white_check_mark` reaction to that reply. The worker that resumes reports what it did in this thread.

  ```sh
  bun app/src/decide-dm.ts answer '<key>' '<reply text as written>'
  ```

- **A question back** (the user asks for facts, context or your view before deciding): do not record a decision. Investigate from the item's `url` (PR, Jira issue, Slack thread, linked docs) and reply in the same thread with a short, sourced answer in Japanese, ending with the options again. Then mark the reply handled so it is not answered twice:

  ```sh
  bun app/src/decide-dm.ts handled '<key>' <reply ts>
  ```

When unsure whether it is an answer, treat it as a question and ask back which option it means.

No new reply: do nothing.

## Update

For each `update` item (its source changed since the thread last reported it): read what changed in the source (`url` and its linked items: new comments, pushes, CI, status, new Slack replies) and reply in the thread with `slack_send_message` (`thread_ts` = `ts`): `【状況更新】` plus one or two lines of what changed and whether it affects the options, with related links as short labels. Then:

```sh
bun app/src/decide-dm.ts updated '<key>'
```

## Remind

For each `remind` item still unanswered after Watch, reply in its thread with `slack_send_message` (`thread_ts` = `ts`, `reply_broadcast: true` so it surfaces in the DM): `【催促】判断待ちです（<経過時間>）` plus the question in one line and any deadline from the source. Then:

```sh
bun app/src/decide-dm.ts reminded '<key>'
```

Skip the reminder for an item you just answered or updated in this run.

## Rules

- Copy question, options and reply text verbatim; do not summarize or translate.
- Never decide on the user's behalf; only a reply the user wrote counts as an answer.
- One message per `post` item; if `posted` fails, do not send it again in this run.
