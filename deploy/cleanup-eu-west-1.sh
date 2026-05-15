#!/usr/bin/env bash
# Cleanup old eu-west-1 AWS resources after migration to eu-central-1.
#
# Prerequisites (must be done before running this script):
#   1. Aurora cluster in eu-west-1 is fully deleted
#   2. DynamoDB eu-west-1 replicas are removed
#   3. CI/CD has successfully applied eu-central-1 infrastructure
#      (new S3 buckets, SQS queues, SNS topics, API Gateway all live)
#
# Usage (from repo root):
#   AWS_PROFILE=<your-admin-profile> bash deploy/cleanup-eu-west-1.sh
#
# Requires: AWS CLI + credentials with delete permissions in eu-west-1.

set -euo pipefail

OLD_REGION="eu-west-1"
SERVICE="SES-Email-Adapter"
SERVICE_LOWER="ses-email-adapter"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "Account : $ACCOUNT_ID"
echo "Region  : $OLD_REGION"
echo "Service : $SERVICE"
echo ""

# ---------------------------------------------------------------------------
# S3 buckets
# ---------------------------------------------------------------------------

delete_bucket() {
  local bucket="$1"
  if aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
    echo "→ Emptying s3://$bucket ..."
    aws s3 rm "s3://$bucket" --recursive
    # Remove any versioned objects / delete markers
    versions=$(aws s3api list-object-versions --bucket "$bucket" \
      --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' \
      --output json 2>/dev/null || echo '{"Objects":[],"DeleteMarkers":[]}')
    for key_query in '.Objects[]' '.DeleteMarkers[]'; do
      items=$(echo "$versions" | jq -c "$key_query // empty" 2>/dev/null || true)
      [ -z "$items" ] && continue
      while IFS= read -r item; do
        key=$(echo "$item" | jq -r '.Key')
        vid=$(echo "$item" | jq -r '.VersionId')
        aws s3api delete-object --bucket "$bucket" --key "$key" --version-id "$vid" > /dev/null
      done <<< "$items"
    done
    echo "  Deleting bucket..."
    aws s3api delete-bucket --bucket "$bucket"
    echo "  ✓ s3://$bucket deleted"
  else
    echo "  s3://$bucket not found — already deleted or never existed"
  fi
}

echo "=== S3 Buckets ==="
delete_bucket "${SERVICE_LOWER}-emails-${ACCOUNT_ID}-eu-west-1-an"
delete_bucket "${SERVICE_LOWER}-web-${ACCOUNT_ID}-eu-west-1-an"
echo ""

# ---------------------------------------------------------------------------
# SQS queues  (discover all with service prefix, includes DLQs)
# ---------------------------------------------------------------------------

echo "=== SQS Queues ==="
QUEUE_URLS=$(aws sqs list-queues \
  --queue-name-prefix "$SERVICE" \
  --region "$OLD_REGION" \
  --query 'QueueUrls[]' \
  --output text 2>/dev/null || true)

if [ -z "$QUEUE_URLS" ]; then
  echo "  No queues found — already deleted or never existed"
else
  for url in $QUEUE_URLS; do
    echo "→ Deleting $url ..."
    aws sqs delete-queue --queue-url "$url" --region "$OLD_REGION"
    echo "  ✓ Deleted"
  done
fi
echo ""

# ---------------------------------------------------------------------------
# SNS topics
# ---------------------------------------------------------------------------

echo "=== SNS Topics ==="
TOPIC_ARNS=$(aws sns list-topics \
  --region "$OLD_REGION" \
  --query "Topics[?contains(TopicArn, '${SERVICE}')].TopicArn" \
  --output text 2>/dev/null || true)

if [ -z "$TOPIC_ARNS" ]; then
  echo "  No topics found — already deleted or never existed"
else
  for arn in $TOPIC_ARNS; do
    echo "→ Deleting $arn ..."
    aws sns delete-topic --topic-arn "$arn" --region "$OLD_REGION"
    echo "  ✓ Deleted"
  done
fi
echo ""

# ---------------------------------------------------------------------------
# Secrets Manager
# ---------------------------------------------------------------------------

echo "=== Secrets Manager ==="

delete_secret() {
  local name="$1"
  local region="${2:-$OLD_REGION}"
  arn=$(aws secretsmanager list-secrets \
    --region "$region" \
    --query "SecretList[?Name=='${name}'].ARN | [0]" \
    --output text 2>/dev/null || true)
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    echo "  Secret '$name' not found in $region — already deleted or never existed"
  else
    echo "→ Deleting secret '$name' ($arn) ..."
    aws secretsmanager delete-secret \
      --secret-id "$arn" \
      --force-delete-without-recovery \
      --region "$region"
    echo "  ✓ Deleted"
  fi
}

# CloudFront origin secret was created in eu-west-1 (no provider in tf, defaulted to old region)
delete_secret "${SERVICE}/cloudfront/origin-secret"

# Aurora managed secret — auto-named by RDS, discover by tag
echo "→ Looking for Aurora-managed secrets in $OLD_REGION ..."
AURORA_SECRETS=$(aws secretsmanager list-secrets \
  --region "$OLD_REGION" \
  --filter Key=tag-key,Values=aws:rds:primaryDBClusterArn \
  --query 'SecretList[].ARN' \
  --output text 2>/dev/null || true)

if [ -z "$AURORA_SECRETS" ]; then
  echo "  No Aurora-managed secrets found — already deleted or cluster not yet deleted"
else
  for arn in $AURORA_SECRETS; do
    echo "→ Deleting Aurora secret $arn ..."
    aws secretsmanager delete-secret \
      --secret-id "$arn" \
      --force-delete-without-recovery \
      --region "$OLD_REGION"
    echo "  ✓ Deleted"
  done
fi
echo ""

# ---------------------------------------------------------------------------
# ACM certificate (eu-west-1 API Gateway cert — orphaned from state)
# ---------------------------------------------------------------------------

echo "=== ACM Certificate (eu-west-1 API Gateway) ==="
CERT_ARNS=$(aws acm list-certificates \
  --region "$OLD_REGION" \
  --query "CertificateSummaryList[?contains(DomainName, 'api.') || contains(DomainName, 'wss.')].CertificateArn" \
  --output text 2>/dev/null || true)

if [ -z "$CERT_ARNS" ]; then
  echo "  No API Gateway certs found in $OLD_REGION — already deleted or never existed"
else
  for arn in $CERT_ARNS; do
    # Skip if still in-use (safety check)
    in_use=$(aws acm describe-certificate \
      --certificate-arn "$arn" \
      --region "$OLD_REGION" \
      --query 'Certificate.InUseBy' \
      --output text 2>/dev/null || true)
    if [ -n "$in_use" ] && [ "$in_use" != "None" ]; then
      echo "  ⚠ Cert $arn is still in use by: $in_use — skipping"
    else
      echo "→ Deleting cert $arn ..."
      aws acm delete-certificate --certificate-arn "$arn" --region "$OLD_REGION"
      echo "  ✓ Deleted"
    fi
  done
fi
echo ""

# ---------------------------------------------------------------------------
# RDS DB subnet group (Aurora deps — safe to delete after Aurora is gone)
# ---------------------------------------------------------------------------

echo "=== RDS DB Subnet Group ==="
SUBNET_GROUP="${SERVICE_LOWER}-aurora"
if aws rds describe-db-subnet-groups \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --region "$OLD_REGION" > /dev/null 2>&1; then
  echo "→ Deleting DB subnet group $SUBNET_GROUP ..."
  aws rds delete-db-subnet-group \
    --db-subnet-group-name "$SUBNET_GROUP" \
    --region "$OLD_REGION"
  echo "  ✓ Deleted"
else
  echo "  DB subnet group $SUBNET_GROUP not found — already deleted or Aurora still present"
fi
echo ""

# ---------------------------------------------------------------------------
# VPC (subnets → security groups → route tables → VPC)
# Discovered via subnet Name tags since the VPC itself has no Name tag.
# ---------------------------------------------------------------------------

echo "=== VPC ==="
VPC_ID=$(aws ec2 describe-subnets \
  --region "$OLD_REGION" \
  --filters "Name=tag:Name,Values=${SERVICE}-private-0" \
  --query 'Subnets[0].VpcId' \
  --output text 2>/dev/null || true)

if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  echo "  VPC not found (subnet ${SERVICE}-private-0 missing) — already deleted or Aurora not yet removed"
else
  echo "  Found VPC: $VPC_ID"

  # Subnets
  echo "→ Deleting subnets..."
  SUBNET_IDS=$(aws ec2 describe-subnets \
    --region "$OLD_REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'Subnets[].SubnetId' \
    --output text)
  for sid in $SUBNET_IDS; do
    aws ec2 delete-subnet --subnet-id "$sid" --region "$OLD_REGION"
    echo "  ✓ $sid"
  done

  # Non-main route tables
  echo "→ Deleting route tables..."
  RT_IDS=$(aws ec2 describe-route-tables \
    --region "$OLD_REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'RouteTables[?Associations[?Main==`false`] || length(Associations)==`0`].RouteTableId' \
    --output text)
  for rtid in $RT_IDS; do
    aws ec2 delete-route-table --route-table-id "$rtid" --region "$OLD_REGION"
    echo "  ✓ $rtid"
  done

  # Security groups (skip default)
  echo "→ Deleting security groups..."
  SG_IDS=$(aws ec2 describe-security-groups \
    --region "$OLD_REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[?GroupName!=`default`].GroupId' \
    --output text)
  for sgid in $SG_IDS; do
    aws ec2 delete-security-group --group-id "$sgid" --region "$OLD_REGION"
    echo "  ✓ $sgid"
  done

  # VPC
  echo "→ Deleting VPC $VPC_ID..."
  aws ec2 delete-vpc --vpc-id "$VPC_ID" --region "$OLD_REGION"
  echo "  ✓ VPC $VPC_ID deleted"
fi
echo ""

# ---------------------------------------------------------------------------
# CloudWatch Log Groups (Lambda logs in eu-west-1)
# ---------------------------------------------------------------------------

echo "=== CloudWatch Log Groups ==="
LOG_GROUPS=$(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/${SERVICE}" \
  --region "$OLD_REGION" \
  --query 'logGroups[].logGroupName' \
  --output text 2>/dev/null || true)

if [ -z "$LOG_GROUPS" ]; then
  echo "  No Lambda log groups found in $OLD_REGION"
else
  for lg in $LOG_GROUPS; do
    echo "→ Deleting log group $lg ..."
    aws logs delete-log-group --log-group-name "$lg" --region "$OLD_REGION"
    echo "  ✓ Deleted"
  done
fi
echo ""

echo "✓ eu-west-1 cleanup complete."
echo ""
echo "Remaining manual checks:"
echo "  - KMS: verify eu-central-1 replica key is active (key is multi-region, managed externally)"
echo "  - SES: if you had a verified identity / receipt rules in eu-west-1, remove them via the SES console"
echo "  - Delete S3 state migration markers once satisfied:"
echo "      aws s3 rm s3://<STATE_BUCKET>/migration/eu-west-1-orphaned"
echo "      aws s3 rm s3://<STATE_BUCKET>/migration/eu-central-1-state-fixed"
