#!/bin/bash
# Run each spec file individually with a 5-second timeout
# Report which ones exceed the timeout (likely hanging)

cd /home/warren/git/claude/email-catcher/backend

HANGING_FILES=()
PASSING_FILES=()
FAILED_FILES=()

mapfile -t SPEC_FILES < <(find src -name "*.spec.ts" -o -name "*.test.ts" | sort)

TOTAL=${#SPEC_FILES[@]}
COUNT=0

echo "========================================="
echo "Starting test scan: $TOTAL spec files"
echo "Timeout per file: 5 seconds"
echo "========================================="
echo ""

for file in "${SPEC_FILES[@]}"; do
  COUNT=$((COUNT + 1))
  echo "[$COUNT/$TOTAL] Testing: $file ..."
  
  START=$(date +%s%N)
  
  # Run with 5 second timeout
  OUTPUT=$(timeout 5 npx vitest run "$file" --no-coverage 2>&1)
  EXIT_CODE=$?
  
  END=$(date +%s%N)
  ELAPSED=$(( (END - START) / 1000000 ))
  
  if [ $EXIT_CODE -eq 124 ]; then
    echo "  ⏰ TIMEOUT after ${ELAPSED}ms (hanging)"
    HANGING_FILES+=("$file")
  elif [ $EXIT_CODE -eq 0 ]; then
    echo "  ✅ Passed in ${ELAPSED}ms"
    PASSING_FILES+=("$file")
  else
    echo "  ❌ Failed in ${ELAPSED}ms (exit code: $EXIT_CODE)"
    FAILED_FILES+=("$file")
  fi
done

echo ""
echo "========================================="
echo "RESULTS"
echo "========================================="
echo ""
echo "Passing (${#PASSING_FILES[@]}):"
for f in "${PASSING_FILES[@]}"; do echo "  ✅ $f"; done
echo ""
echo "Failed (${#FAILED_FILES[@]}):"
for f in "${FAILED_FILES[@]}"; do echo "  ❌ $f"; done
echo ""
echo "HANGING/TIMEOUT (${#HANGING_FILES[@]}):"
for f in "${HANGING_FILES[@]}"; do echo "  ⏰ $f"; done
echo ""
echo "Done. Scanned $TOTAL files."
