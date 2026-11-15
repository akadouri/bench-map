#!/usr/bin/env bash
# Refresh src/schemas/ from the producer repository and regenerate the types.
# Only schemas already present in src/schemas/ are updated; to start using a new
# schema, copy it in by hand first.
set -euo pipefail

: "${BENCH_DATA_REPO:?Set BENCH_DATA_REPO to the producer repository path}"
for file in src/schemas/*.schema.json; do
  cp "$BENCH_DATA_REPO/schemas/$(basename "$file")" "$file"
done
npm run generate:types
