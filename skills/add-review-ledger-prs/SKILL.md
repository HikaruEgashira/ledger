---
name: add-review-ledger-prs
description: Add live-verified exact <org> pull request URLs to this workspace's pull_requests.jsonl review ledger. Use when an exact PR URL is supplied by the user or appears in the current review, release, or recovery evidence. No separate user confirmation is required for intake. Never use it to expand a search, author, label, repository, wildcard, or other candidate set, retarget an existing row, or bulk-import results.
---

# Add review ledger PRs

Keep this trusted intake separate from review and approval. Read
[references/manual-intake-policy.md](references/manual-intake-policy.md) before
changing the ledger.

## Add exact URLs

1. Require one or more exact `https://github.com/<org>/.../pull/...` URLs
   already present in the current task context or in live evidence from a
   listed PR. Never search for more PRs or expand an organization, repository,
   author, label, query, or wildcard.
2. Use priority `50` unless the user specifies another value from `0` through
   `100`. Record the concrete source and relevance as a concise `--reason`.
3. Validate the current ledger:

   ```bash
   bun app/src/intakectl.ts validate
   ```

4. Run a live dry-run. It reads each PR using the authenticated GitHub session,
   rejects non-open PRs, and makes no ledger change:

   ```bash
   bun app/src/intakectl.ts add \
     <PR_URL> --priority 50 --reason "<exact URL source and relevance>"
   ```

5. If the dry-run succeeds, repeat with `--execute`; intake needs no separate
   user confirmation:

   ```bash
   bun app/src/intakectl.ts add \
     <PR_URL> --priority 50 --reason "<exact URL source and relevance>" --execute
   ```

   Multiple exact URLs may follow `add`. The new rows are written together
   only after every new URL passes live validation. Existing URLs are reported
   as `already_listed` and are not modified.

6. Run `validate` again and hand the queue back to
   `$review-ledger-prs`. Intake itself never approves, requests changes,
   dispatches, merges, or releases.

Do not edit, delete, reprioritize, or retarget existing rows. Do not create test
code for the intake script; verify it against the real ledger and live PRs only.
