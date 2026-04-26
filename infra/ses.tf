# ---------------------------------------------------------------------------
# SES receipt rule set and rules
# Domains are added by the API when users register them
# ---------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = "${local.prefix}-rules"
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
# Platform domain identity — Easy DKIM (AWS-managed keys)
# Per-customer domains are registered dynamically via the API using BYODKIM.
# ---------------------------------------------------------------------------

resource "aws_sesv2_email_identity" "main" {
  email_identity = local.mail_domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# 3 DKIM CNAME records supplied by SES Easy DKIM
resource "aws_route53_record" "ses_dkim" {
  provider = aws.us_east_1
  count    = 3
  zone_id  = var.hosted_zone_id
  name     = "${aws_sesv2_email_identity.main.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.mail_domain}"
  type     = "CNAME"
  ttl      = 300
  records  = ["${aws_sesv2_email_identity.main.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# MX record — routes inbound email through SES
resource "aws_route53_record" "ses_mx" {
  provider = aws.us_east_1
  zone_id  = var.hosted_zone_id
  name     = local.mail_domain
  type     = "MX"
  ttl      = 300
  records  = ["10 inbound-smtp.eu-west-1.amazonaws.com"]
}

# SPF — authorises SES to send on behalf of this domain
resource "aws_route53_record" "ses_spf" {
  provider = aws.us_east_1
  zone_id  = var.hosted_zone_id
  name     = local.mail_domain
  type     = "TXT"
  ttl      = 300
  records  = ["v=spf1 include:amazonses.com ~all"]
}

# DMARC — quarantine policy; tighten to p=reject once sending is stable
resource "aws_route53_record" "dmarc" {
  provider = aws.us_east_1
  zone_id  = var.hosted_zone_id
  name     = "_dmarc.${local.mail_domain}"
  type     = "TXT"
  ttl      = 300
  records  = ["v=DMARC1; p=quarantine; rua=mailto:postmaster@${local.mail_domain}"]
}

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
