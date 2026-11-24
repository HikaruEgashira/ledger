---
name: decide-dm
description: Post pending human decisions (own-PR and Slack/Jira task questions) to the user's Slack DM and turn the user's thread replies into decisions. Use when `bun app/src/decide-dm.ts sync` starts a run with a plan.
---

# Decide over Slack DM

The DM to the user is for decisions only. Post nothing else there.

The prompt gives the DM user id and a plan: `post` (new questions) and `watch` (questions already posted, with `channel` and `ts`).

## Post

For each `post` item, send one message to the DM user with `slack_send_message`:

```
【判断】<title>
<question>
1. <option 1>
2. <option 2>
...
<url>
返信: 番号 か 自由記述（このスレッドに）
```

Then record it with the returned channel and ts:

```sh
bun app/src/decide-dm.ts posted '<key>' <channel> <ts>
```

## Watch

Find replies with one search, not one read per item (Slack rate limits): `slack_search_public_and_private` with `from:<@DM user> after:<date of the oldest watch at>`, `channel_types: im`, `sort: timestamp`. Only for watch items whose `ts` is the thread of a hit, read that thread (`slack_read_thread` with `channel`, `ts`) and take the latest reply written by the DM user after the post (ignore bot and app messages). If there is one:

```sh
bun app/src/decide-dm.ts answer '<key>' '<reply text as written>'
```

Then add a `white_check_mark` reaction to that reply. Do not post a reply.

No reply yet: do nothing.

## Rules

- Copy question, options and reply text verbatim; do not summarize or translate.
- Never answer on the user's behalf; only a reply the user wrote counts.
- One message per `post` item; if `posted` fails, do not send it again in this run.
