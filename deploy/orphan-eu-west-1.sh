#!/usr/bin/env bash
# One-time migration: orphan all eu-west-1 regional resources from Tofu state.
#
# After running this, the next CI apply creates fresh eu-central-1 resources
# without touching the old eu-west-1 ones — they keep running in AWS as
# unmanaged orphans until you manually delete them.
#
# Usage (from repo root):
#   STATE_BUCKET=rhosys-opentofu-<account>-eu-central-1 \
#   STATE_KEY=SES-Email-Adapter/terraform.tfstate \
#   bash deploy/orphan-eu-west-1.sh
#
# Requires: tofu + AWS credentials with state read/write access.
# Safe to re-run — state rm is a no-op if the resource is already gone.

set -euo pipefail
cd "$(dirname "$0")/.."

: "${STATE_BUCKET:?Set STATE_BUCKET to the eu-central-1 state bucket}"
: "${STATE_KEY:?Set STATE_KEY to the Tofu state key}"

echo "→ Initialising Tofu against eu-central-1 state bucket..."
tofu -chdir=deploy init -input=false \
  -backend-config="bucket=${STATE_BUCKET}" \
  -backend-config="key=${STATE_KEY}" \
  -reconfigure

echo "→ Reading current state..."
RESOURCES=$(tofu -chdir=deploy state list 2>/dev/null || true)

if [ -z "$RESOURCES" ]; then
  echo "State is empty — nothing to orphan."
  exit 0
fi

# Keep global/us-east-1 resources that don't need to move:
#   aws_iam_*          — IAM is global
#   aws_acm_*          — certificates are in us-east-1 (CloudFront requirement)
#   aws_cloudfront_*   — CloudFront is global
#   aws_route53_*      — Route53 is global
#   random_*           — random values, regenerating causes unnecessary churn
KEEP="^(aws_iam_|aws_acm_|aws_cloudfront_|aws_route53_|random_)"

TO_REMOVE=$(echo "$RESOURCES" | grep -vE "$KEEP" || true)

if [ -z "$TO_REMOVE" ]; then
  echo "No regional resources found in state — already migrated."
  exit 0
fi

echo "→ Orphaning regional eu-west-1 resources:"
while IFS= read -r addr; do
  echo "   removing: $addr"
  tofu -chdir=deploy state rm "$addr" 2>/dev/null || echo "   (already removed)"
done <<< "$TO_REMOVE"

echo ""
echo "✓ Done. Old eu-west-1 resources are now unmanaged in AWS."
echo "  Trigger CI to create fresh eu-central-1 resources."
echo ""
echo "  Clean up old resources later with:"
echo "    aws rds delete-db-cluster --db-cluster-identifier <id> --skip-final-snapshot"
echo "    aws s3 rm s3://<bucket> --recursive && aws s3 rb s3://<bucket>"
echo "    aws dynamodb delete-table --table-name <name> --region eu-west-1"
