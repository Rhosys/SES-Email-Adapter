#!/usr/bin/env bash
set -euo pipefail

# Integration test infrastructure provisioning.
#
#   1. Transform the production deploy/*.tf into MiniStack-ready .tf.json via
#      transform-tf.ts (structural hcl2json transforms — replaces the old
#      fragile sed stripping and the hand-maintained deploy/integration override).
#   2. Seed the externally-managed state the production data sources read:
#        - the Route53 hosted zone (data.aws_route53_zone.main, us-east-1),
#        - the alias/default KMS key (data.aws_kms_alias.default).
#      Production declares these as data sources against shared/pre-existing AWS
#      resources; integration seeds equivalents so the real .tf resolves unchanged.
#      (The DKIM data.aws_kms_secrets block is instead replaced by transform-tf.ts
#      with a generated tls_private_key — a KMS Decrypt can't be seeded.)
#   3. tofu init + apply against the generated .tf.json (full apply, no -target).
#   4. Write env vars to /tmp/integration-env.sh for CI sourcing.
#
# All MiniStack gaps are declared as transforms in transform-tf.ts — see that
# file to add a new gap.

TOFU_VERSION="1.12.0"
TOFU_BIN="/usr/local/bin/tofu"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-ministack-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-ministack-test}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"

# --- Install OpenTofu if not present ---
if ! command -v tofu &>/dev/null; then
  echo "Installing OpenTofu ${TOFU_VERSION}..."
  curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_amd64.zip" -o /tmp/tofu.zip
  unzip -o /tmp/tofu.zip -d /tmp/tofu-bin
  mv /tmp/tofu-bin/tofu "${TOFU_BIN}"
  chmod +x "${TOFU_BIN}"
  rm -rf /tmp/tofu.zip /tmp/tofu-bin
  echo "OpenTofu ${TOFU_VERSION} installed at ${TOFU_BIN}"
fi

# --- Create temp dir with cleanup trap ---
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "${WORK_DIR}"; }
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${SCRIPT_DIR}/../../deploy"
ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
ZONE_NAME="email.rhosys.cloud"

# --- Transform production .tf → MiniStack .tf.json ---
echo "Transforming production TF for MiniStack..."
npx tsx "${SCRIPT_DIR}/transform-tf.ts" "${DEPLOY_DIR}" "${WORK_DIR}" "${ENDPOINT}"

# --- Seed Route53 hosted zone (data.aws_route53_zone.main, resolved via us-east-1) ---
# Idempotent: only create when absent, so repeated local runs against a
# persistent MiniStack don't accumulate duplicate zones (the data source
# requires exactly one match).
echo "Seeding Route53 hosted zone..."
EXISTING_ZONES=$(aws route53 list-hosted-zones-by-name \
  --dns-name "${ZONE_NAME}" \
  --endpoint-url "${ENDPOINT}" --region us-east-1 \
  --query "length(HostedZones[?Name=='${ZONE_NAME}.'])" --output text 2>/dev/null || echo "0")
if [ "${EXISTING_ZONES}" = "0" ]; then
  aws route53 create-hosted-zone \
    --name "${ZONE_NAME}" \
    --caller-reference "integration-$(date +%s)" \
    --endpoint-url "${ENDPOINT}" --region us-east-1 >/dev/null 2>&1 || true
fi

# --- Seed the alias/default KMS key (data.aws_kms_alias.default) ---
echo "Seeding alias/default KMS key..."
DEFAULT_KEY_ID=$(aws kms create-key \
  --endpoint-url "${ENDPOINT}" \
  --query 'KeyMetadata.KeyId' --output text 2>/dev/null)
aws kms create-alias \
  --alias-name "alias/default" \
  --target-key-id "${DEFAULT_KEY_ID}" \
  --endpoint-url "${ENDPOINT}" >/dev/null 2>&1 || true

# NOTE: The production data.aws_kms_secrets.dkim block (a KMS Decrypt of a
# committed ciphertext file) is replaced by transform-tf.ts with a generated
# tls_private_key, so no DKIM secret seeding is needed here. See transform-tf.ts.

# --- Run tofu init + apply ---
echo "Running tofu init..."
tofu -chdir="${WORK_DIR}" init -reconfigure -input=false

echo "Running tofu apply..."
tofu -chdir="${WORK_DIR}" apply -auto-approve -input=false -refresh=false \
  -var="aws_account_id=000000000000"

# --- Write env vars for CI sourcing (read resource names from tofu output) ---
ACCOUNTS_TABLE=$(tofu -chdir="${WORK_DIR}" output -raw dynamodb_accounts_table)
SIGNALS_TABLE=$(tofu -chdir="${WORK_DIR}" output -raw dynamodb_signals_table)
PROCESSING_TABLE=$(tofu -chdir="${WORK_DIR}" output -raw dynamodb_processing_table)
AUDIT_TABLE=$(tofu -chdir="${WORK_DIR}" output -raw dynamodb_audit_table)
EMAIL_BUCKET=$(tofu -chdir="${WORK_DIR}" output -raw email_bucket_name)
SIGNAL_QUEUE_URL=$(tofu -chdir="${WORK_DIR}" output -raw signals_queue_url)

cat > /tmp/integration-env.sh <<EOF
export ACCOUNTS_TABLE="${ACCOUNTS_TABLE}"
export SIGNALS_TABLE="${SIGNALS_TABLE}"
export PROCESSING_TABLE="${PROCESSING_TABLE}"
export AUDIT_TABLE="${AUDIT_TABLE}"
export EMAIL_BUCKET="${EMAIL_BUCKET}"
export CONTENT_BUCKET="ses-it-content"
export SIGNAL_QUEUE_URL="${SIGNAL_QUEUE_URL}"
export CONTENT_CDN_BASE_URL="${ENDPOINT}/ses-it-content"
export AWS_ENDPOINT_URL="${ENDPOINT}"
export AWS_REGION="eu-central-1"
export AWS_ACCESS_KEY_ID="ministack-test"
export AWS_SECRET_ACCESS_KEY="ministack-test"
export AUTHRESS_API_URL="http://localhost:4500"
EOF

echo "Provisioning complete. Accounts table: ${ACCOUNTS_TABLE}"
echo "Source /tmp/integration-env.sh to load env vars."
