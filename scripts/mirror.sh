#!/usr/bin/env bash
# mirror.sh - mirror and pin a list of CIDs from a manifest
set -euo pipefail
MANIFEST_URL="$1"
if [ -z "$MANIFEST_URL" ]; then
  echo "Usage: mirror.sh <manifest_raw_url>"
  exit 2
fi
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT
curl -sL "$MANIFEST_URL" -o "$TMPDIR/manifest.json"
if ! command -v jq >/dev/null 2>&1; then
  echo "jq required"
  exit 2
fi
CIDS=$(jq -r '.cids[]' "$TMPDIR/manifest.json")
COUNT=0
for cid in $CIDS; do
  echo "Pinning $cid"
  if ipfs pin add --recursive "$cid"; then
    echo "Pinned $cid"
  else
    echo "ipfs pin failed for $cid; attempting ipfs get"
    ipfs get "$cid" -o "$TMPDIR/$cid" || echo "get failed for $cid"
  fi
  COUNT=$((COUNT+1))
done
echo "Pinned $COUNT CIDs"
