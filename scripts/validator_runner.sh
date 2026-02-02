#!/usr/bin/env bash
# validator_runner.sh <provenance_dir_or_file>
set -euo pipefail
TARGET="$1"
if [ -z "$TARGET" ]; then
  echo "Usage: validator_runner.sh <provenance_dir_or_file>"
  exit 2
fi

# Example validator: verify JSON schema, verify signature (placeholder), run optional tests
# This script should be adapted to your agent signature scheme.
if [ -d "$TARGET" ]; then
  FILES=$(ls -1 "$TARGET"/*.json 2>/dev/null || true)
else
  FILES="$TARGET"
fi

if [ -z "$FILES" ]; then
  echo "No files to validate"
  exit 1
fi

for f in $FILES; do
  echo "Validating $f"
  if ! jq -e . "$f" >/dev/null 2>&1; then
    echo "Invalid JSON: $f"
    exit 1
  fi
  # Basic schema checks
  for key in record_id actor_id project_id task_id action result_cid timestamp signature; do
    if ! jq -e "has(\"$key\")" "$f" >/dev/null; then
      echo "Missing key $key in $f"
      exit 1
    fi
  done
  # Placeholder signature verification: ensure signature field non-empty
  SIG=$(jq -r .signature "$f")
  if [ -z "$SIG" ] || [ "$SIG" = "null" ]; then
    echo "Missing signature in $f"
    exit 1
  fi
  # Optionally run sandboxed tests here (WASM/Docker)
  # For now, produce a validator_score file
  echo '{"validator_score":1.0}' > "${f}.validator.json"
done

echo "All validations passed"
exit 0
