#!/usr/bin/env bash
set -uo pipefail

# Local MiniStack provisioning loop — NOT used in CI.
#
# Each iteration runs against a PRISTINE MiniStack so "already exists" collisions
# from a prior partial apply never mask the real next gap. The loop:
#   1. restart the ministack-local container (clean state),
#   2. run provision.sh once,
#   3. on success → stop; on failure → record the distinct errors and loop.
#
# Every unique error line is appended to the gap log so the full set of missing
# MiniStack actions accumulates across iterations in one place.
#
# Usage:
#   bash run-local.sh [maxIterations]   # default 15
#
# Requires: docker, and the ministack image pulled.

MINISTACK_VERSION="1.5.21"
MINISTACK_IMAGE="ministackorg/ministack:${MINISTACK_VERSION}"
CONTAINER="ministack-local"
ENDPOINT="http://localhost:4566"
MAX_ITER="${1:-15}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAP_LOG="/tmp/ministack-gaps.log"
: > "${GAP_LOG}"

restart_ministack() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  docker run -d --rm --name "${CONTAINER}" -p 4566:4566 "${MINISTACK_IMAGE}" >/dev/null
  for _ in $(seq 1 60); do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "${ENDPOINT}/" 2>/dev/null || echo 000)
    [ "${code}" != "000" ] && return 0
    sleep 1
  done
  echo "MiniStack failed to start" >&2
  return 1
}

# Extract the distinct AWS error signatures from a provision run's output.
# Captures the "Error: ..." headline and the API error line beneath it.
extract_errors() {
  grep -E "Error:|operation error|InvalidAction|NotFoundException|BadRequestException|ResourceNotFoundException" "$1" \
    | grep -v -E "ResourceInUseException|EntityAlreadyExists|ConflictException|already exists" \
    | sort -u
}

for iter in $(seq 1 "${MAX_ITER}"); do
  echo "=== Iteration ${iter}: restarting MiniStack ==="
  restart_ministack || exit 1

  OUT="/tmp/ministack-provision-${iter}.log"
  echo "=== Iteration ${iter}: running provision.sh ==="
  AWS_ENDPOINT_URL="${ENDPOINT}" bash "${SCRIPT_DIR}/provision.sh" > "${OUT}" 2>&1
  STATUS=$?

  if [ "${STATUS}" -eq 0 ]; then
    echo "=== Iteration ${iter}: provision SUCCEEDED (exit 0) ==="
    echo "Full gap log across all iterations: ${GAP_LOG}"
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    exit 0
  fi

  echo "=== Iteration ${iter}: FAILED — distinct errors ==="
  {
    echo "--- iteration ${iter} ---"
    extract_errors "${OUT}"
  } | tee -a "${GAP_LOG}"
  echo
  echo "(full output: ${OUT})"
  echo
done

echo "=== Reached max iterations (${MAX_ITER}) without a clean apply ==="
echo "Accumulated gap log: ${GAP_LOG}"
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
exit 1
