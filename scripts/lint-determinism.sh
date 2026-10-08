#!/usr/bin/env bash
# Determinism lint (user CLAUDE.md:30; ~/.claude/reproducible-data-manipulation.md, "Determinism
# hazards"). Bans the seven hazards in transform code: clock, randomness, locale-sensitive
# comparison, Set or Map built from concurrently resolved results, order-dependent merge of
# parallel results, a network fetch mid-transform, and an inline model call.
# The one pattern list is scripts/determinism-patterns.txt (one extended regex per line, no blank
# lines). This script, tests/determinism-lint.test.ts, #8's source-scan test and #15's sweep all
# read that file; none keeps its own copy.
# Scope: every *.ts under the first argument (default scripts/ingest), except fetch.ts, imagery.ts, context.ts, sky.ts and fetch-buildings.ts (the five
# ingestion steps; each legitimately records fetched-at and fetches), plus the extra files named by
# the remaining arguments (default src/scene/drape.ts and src/ui/filter-predicate.ts, which land
# in E3; an extra file that does not exist yet is skipped, once it exists it is scanned).
# Usage: scripts/lint-determinism.sh [dir [extra-file ...]]
# Exit codes: 0 = clean, 1 = hazard found (hits printed), 2 = instrument error (missing dir,
# missing or empty pattern file, or grep failure). An instrument error is never reported as clean.
set -u
dir="${1:-scripts/ingest}"
patterns="$(dirname "$0")/determinism-patterns.txt"
if [ ! -d "$dir" ]; then
  echo "lint-determinism: directory not found: $dir" >&2
  exit 2
fi
if [ ! -s "$patterns" ]; then
  echo "lint-determinism: pattern file missing or empty: $patterns" >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  extras=(src/scene/drape.ts src/ui/filter-predicate.ts)
else
  shift
  extras=("$@")
fi
files=()
for f in ${extras[@]+"${extras[@]}"}; do
  if [ -f "$f" ]; then files+=("$f"); fi
done
grep -rnE -f "$patterns" --include='*.ts' --exclude='fetch.ts' --exclude='imagery.ts' --exclude='imagery-inset.ts' --exclude='context.ts' --exclude='sky.ts' --exclude='fetch-buildings.ts' "$dir"
dir_status=$?
file_status=1
if [ "${#files[@]}" -gt 0 ]; then
  grep -nE -f "$patterns" "${files[@]}"
  file_status=$?
fi
if [ "$dir_status" -ge 2 ] || [ "$file_status" -ge 2 ]; then
  echo "lint-determinism: grep failed (dir status $dir_status, file status $file_status)" >&2
  exit 2
fi
if [ "$dir_status" -eq 0 ] || [ "$file_status" -eq 0 ]; then
  echo "lint-determinism: banned determinism hazard found (see hits above)" >&2
  exit 1
fi
exit 0
