# ---------------------------------------------------------------------------
# Bedrock model subscription — accepts the EULA for third-party models
# ---------------------------------------------------------------------------

locals {
  # Must match CLASSIFICATION_MODEL_ID in src/classifier/classifier.ts
  classification_model_id = "qwen.qwen3-32b-v1:0"
}

# Runs exactly once: local-exec provisioners fire on CREATE only.
# No triggers_replace => never re-runs on subsequent applies.
# If the script exits non-zero, TF taints the resource and retries next apply
# (the script is idempotent, so a retry is safe).
resource "terraform_data" "bedrock_model_subscription" {
  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      REGION="${data.aws_region.current.id}"
      MODEL_ID="${local.classification_model_id}"

      # 1. Skip if already entitled (subscription is account-scoped + one-time).
      STATUS=$(aws bedrock get-foundation-model-availability \
        --region "$REGION" --model-id "$MODEL_ID" \
        --query 'agreementAvailability.status' --output text 2>/dev/null || echo "UNKNOWN")

      if [ "$STATUS" = "AVAILABLE" ] || [ "$STATUS" = "ACTIVE" ]; then
        echo "Already subscribed to $MODEL_ID in $REGION. Nothing to do."
        exit 0
      fi

      # 2. Fetch the offer token.
      OFFER_TOKEN=$(aws bedrock list-foundation-model-agreement-offers \
        --region "$REGION" --model-id "$MODEL_ID" \
        --query 'offers[0].offerToken' --output text)

      if [ -z "$OFFER_TOKEN" ] || [ "$OFFER_TOKEN" = "None" ]; then
        echo "No offer token returned for $MODEL_ID in $REGION." >&2
        exit 1
      fi

      # 3. Accept the agreement (triggers the Marketplace subscription).
      aws bedrock create-foundation-model-agreement \
        --region "$REGION" --model-id "$MODEL_ID" \
        --offer-token "$OFFER_TOKEN"

      echo "Subscription requested for $MODEL_ID in $REGION."
    EOT
  }
}
