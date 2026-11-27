---
name: slack
description: Slack threads that involve me. One task per thread.
mcp: slack
hosts: [slack.com]
urls:
  - match: '/archives/(?<scope>[A-Z0-9]+)/p\d{16}\?(?:.*&)?thread_ts=(?<key>\d+\.\d+)'
  - match: '/archives/(?<scope>[A-Z0-9]+)/p(?<s>\d{10})(?<us>\d{6})'
    key: '{s}.{us}'
---

# Slack

## Collect

The prompt gives a recent window and a backfill window for this source. With `slack_search_public_and_private` (`with:me`, `include_bots: true`, `response_format: detailed`, `include_context: false`; concise drops the permalinks), follow `cursor` to the last page. A person's `id` is their Slack user ID; use `with:<@<id>>` for them (handles do not match), recent and backfill only:

- recent: `after:<recent window start date>`, `sort: timestamp`, `sort_dir: asc`. Run it first. Report `--recent-covered-until slack=<ISO of the newest recent hit you emitted>`.
- backfill: `after:<backfill window start date>`, `sort: timestamp`, `sort_dir: asc`. Report `--covered-until slack=<ISO of the newest backfill hit you emitted>`.
- keywords: for each `{q, after}` the prompt lists for slack, one search with `q` as given (no `with:me`), `after:<date of after>`, newest first, at most 2 pages, stopping at the first hit older than `after`. Report the ones you ran with `--keywords-searched slack='<JSON array of q>'`.

- alert channels: for each channel ID the prompt lists under `alert_channels`, one search `in:<#ID>` with `include_bots: true`, `after:<recent window start date>`, newest first, at most 2 pages. Emit every alert thread root (bot or app posts such as CloudWatch alarms), even when nobody mentions me, with `axis: "review"` and a summary that names the alarm, the resource and the account. Their OK/recovery notices go in too; the worker closes them.

Skip my DM with myself, and relays of items another inbox owns (GitHub PR events belong to the PR ledgers). Keep other bot and app DMs. Group hits by thread root: `url` = thread root permalink, `activity` = ISO time of the newest hit in the thread, `ball: "triage"`, `axis: "review"` (placeholder).

## Act

- Reply in the thread, never in the channel root. No apology or agreement openers.
- Private conversations are draft-only: in a private channel, DM or group DM, never call `slack_send_message`; write the reply with `slack_send_message_draft` in the same thread, then `tasks.ts dispatch <ID> --reason "下書き済み: 確認して送信してください" --option "送信した"`. Public channels may be posted directly.
- My reactions (✅, :done:, :ok: and the like) count as replies.
- Links in messages use `<url|label>` with short labels.
