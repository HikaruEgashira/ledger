#!/bin/zsh -i
# Daily closed loop: aggregate stats -> `code -p` implements one improvement -> restore on failed verification.
# Runs as interactive zsh so the user's `code` alias (CLAUDE_CONFIG_DIR=~/.claude-code claude) resolves.
set -u
root=${0:A:h:h}
cd "$root"
day=$(date +%F)
log="$root/logs/retro/$day.log"
summary=$(python3 scripts/daily_retro.py) || exit 1
backup="$root/logs/retro/$day.tar.gz"
tar -czf "$backup" app/src skills config scripts launchd README.md

prompt="review-factory の毎日の自動振り返りです。人間の介入なしで、提案から実装まで完了させてください。

入力: $summary（ローカル集計の統計）と logs/retro/history.md（過去の改善履歴）。
review-artifacts/ 配下は読まないこと。

目的: レビューをより決定的にし、エージェントが動く頻度を減らして速度を上げる。
1. 統計から、エージェント起動・待ち・繰り返し失敗の最大要因を1つ特定する
2. それを決定的ロジックで解消する最小の変更を app/src・skills・config・scripts に実装し、テストを追加する
3. cd app && bun x vp test と python3 -m py_compile skills/review-ledger-prs/scripts/*.py を通す
4. logs/retro/history.md に「日付 / 要因 / 変更 / 期待効果」を1行追記する

制約: 作成者向けレビューコメントに決定的ロジックの詳細を出さない。完全に決定的に承認する場合の本文は「LGTM!」のみ。
改善余地がなければ history.md に「変更なし」と理由を1行書いて終える。"

# Prompt goes via stdin: --allowedTools is variadic and would swallow a trailing prompt argument.
print -r -- "$prompt" | code -p --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Bash" >> "$log" 2>&1

if ! (cd app && bun x vp test >> "$log" 2>&1) || ! python3 -m py_compile skills/review-ledger-prs/scripts/*.py >> "$log" 2>&1; then
  tar -xzf "$backup"
  echo "$day / 検証失敗のため変更を復元" >> logs/retro/history.md
fi
