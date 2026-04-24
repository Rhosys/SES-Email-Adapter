# ---------------------------------------------------------------------------
# SES receipt rule set and rules
# Domains are added by the API when users register them
# ---------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = var.ses_rule_set_name
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}

# Default catch-all rule: store raw email to S3 and notify via SNS
# The API adds per-domain rules above this one via PutReceiptRule
resource "aws_ses_receipt_rule" "store_and_notify" {
  name          = "store-and-notify"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  enabled       = true
  scan_enabled  = true  # Enable SES spam/virus scanning
  tls_policy    = "Require"
  recipients    = []    # Empty = matches all recipients

  s3_action {
    bucket_name       = aws_s3_bucket.emails.id
    object_key_prefix = "emails/"
    topic_arn         = aws_sns_topic.ses_notifications.arn
    position          = 1
  }

  depends_on = [aws_s3_bucket_policy.emails]
}

# ---------------------------------------------------------------------------
# DKIM selector record (intermediate CNAME target)
# User-facing DNS records point to these; they rotate DKIM keys transparently
# ---------------------------------------------------------------------------

# The DKIM signing private keys are uploaded per-domain via the API
# using PutEmailIdentityDkimSigningAttributes (BYODKIM).
# Selector is hardcoded to "email-signals" across all domains.

# ---------------------------------------------------------------------------
# SES Production: configuration set + bounce/complaint event destinations
# All outbound mail must reference this configuration set.
# ---------------------------------------------------------------------------

resource "aws_sesv2_configuration_set" "sending" {
  configuration_set_name = "${local.prefix}-sending"

  sending_options {
    sending_enabled = true
  }

  # Auto-suppress addresses that hard-bounce or complain — belt + suspenders
  # alongside our DynamoDB suppression list.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sns_topic" "ses_feedback" {
  name = "${local.prefix}-ses-feedback"
}

# Route Bounce and Complaint events to SNS so Lambda can update the suppression list
resource "aws_sesv2_configuration_set_event_destination" "feedback" {
  configuration_set_name = aws_sesv2_configuration_set.sending.configuration_set_name
  event_destination_name = "feedback"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]

    sns_destination {
      topic_arn = aws_sns_topic.ses_feedback.arn
    }
  }
}
