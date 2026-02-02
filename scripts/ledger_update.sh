#!/usr/bin/env bash
# ledger_update.sh --actor <actor_id> --credits <n> --reason "<text>"
set -euo pipefail
ACTOR=""
CREDITS=0
REASON=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --actor) ACTOR="$2"; shift 2;;
    --credits) CREDITS="$2"; shift 2;;
    --reason) REASON="$2"; shift 2;;
    *) echo "Unknown arg $1"; exit 2;;
  esac
done
if [ -z "$ACTOR" ]; then
  echo "Missing --actor"
  exit 2
fi
LEDGER_FILE="ledger/ledger.json"
mkdir -p ledger
if [ ! -f "$LEDGER_FILE" ]; then
  echo "{}" > "$LEDGER_FILE"
fi
TMP=$(mktemp)
jq --arg actor "$ACTOR" --argjson credits "$CREDITS" --arg reason "$REASON" '
  . as $ledger |
  ($ledger[$actor] // {credits:0,staked:0,reputation:0,last_updated:null,history:[]}) as $entry |
  ($entry | .credits = ($entry.credits + $credits) | .last_updated = now | .history = (($entry.history // []) + [{time: now, change: $credits, reason: $reason}])) |
  .[$actor] = $entry
' "$LEDGER_FILE" > "$TMP"
mv "$TMP" "$LEDGER_FILE"
# Create a signed snapshot (GPG must be available on self-hosted runner)
git add "$LEDGER_FILE"
git commit -m "Ledger update: $ACTOR +$CREDITS ($REASON)" -S || true
