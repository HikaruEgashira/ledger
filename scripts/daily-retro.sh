#!/bin/zsh
# End-of-day closed loop: auto-decide batch, aggregate stats -> worker_command (opus, low effort) implements one improvement -> restore on failed verification.
set -u
root=${0:A:h:h}
cd "$root"
day=$(date +%F)
log="$root/logs/retro/$day.log"
mkdir -p "$root/logs/retro"
bun app/src/auto-decide.ts >> "$log" 2>&1 || echo "auto-decide failed" >> "$log"
bun app/src/lib/tiers.ts >> "$log" 2>&1 || echo "tiers failed" >> "$log"
summary=$(bun app/src/daily-retro.ts) || exit 1
backup="$root/logs/retro/$day.tar.gz"
tar -czf "$backup" app/src skills config scripts launchd README.md

prompt="ledger の毎日の自動振り返りです。人間の介入なしで、提案から実装まで完了させてください。

入力: $summary（ローカル集計の統計）と logs/retro/history.md（過去の改善履歴）。
review-artifacts/ 配下は読まないこと。

目的: レビューをより決定的にし、エージェントが動く頻度を減らして速度を上げる。haiku で足りる仕事を haiku に寄せる。
1. 統計から、エージェント起動・待ち・繰り返し失敗の最大要因を1つ特定する
2. それを決定的ロジックで解消する最小の変更を app/src・skills・config・scripts に実装し、テストを追加する
3. cd app && bun test と bun run typecheck を通す
4. logs/retro/history.md に「日付 / 要因 / 変更 / 期待効果」を1行追記する

制約: 作成者向けレビューコメントに決定的ロジックの詳細を出さない。完全に決定的に承認する場合の本文は「LGTM!」のみ。
モデル振り分け: logs/tiers/learned.json と outcomes.jsonl を見て、default のまま失敗が少ない作業を独立 scope に切り出す（例: authored-<reason>, task の axis）と app/src/lib/tiers.ts の evolve が成績で haiku へ昇格・降格させる。昇降格の判定を手で書き換えないこと。
改善余地がなければ history.md に「変更なし」と理由を1行書いて終える。"

print -r -- "$prompt" | bun app/src/lib/worker.ts >> "$log" 2>&1

if ! (cd app && bun test >> "$log" 2>&1 && bun run typecheck >> "$log" 2>&1); then
  tar -xzf "$backup"
  echo "$day / 検証失敗のため変更を復元" >> logs/retro/history.md
fi
