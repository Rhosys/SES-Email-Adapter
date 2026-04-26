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
# Platform domain identity — BYODKIM (bring your own key)
# Per-customer domains are registered dynamically via the API using the same key.
# ---------------------------------------------------------------------------

resource "aws_sesv2_email_identity" "main" {
  email_identity = local.mail_domain

  # BYODKIM: one selector + private key works identically in every region.
  # Selector is "mail"; the matching public key is published via the CNAME below.
  dkim_signing_attributes {
    domain_signing_selector    = "mail"
    domain_signing_private_key = var.dkim_private_key
  }

  # Custom MAIL FROM: SPF lives on the bounce subdomain so customers only need
  # a CNAME (bounce.{their} → bounce.{ours}) instead of adding a TXT record.
  # DMARC relaxed alignment still passes because bounce.{their} and {their}
  # share the same organisational domain.
  mail_from_attributes {
    mail_from_domain = "bounce.${local.mail_domain}"
  }
}

# Shared DKIM terminus — all customer domains CNAME here instead of directly to
# amazonses.com. Because every customer domain is registered with the same BYODKIM
# private key, the public key served at this endpoint is valid for all of them.
# Customer creates: mail._domainkey.{their_domain} CNAME mail._domainkey.{mail_domain}
resource "aws_route53_record" "ses_dkim" {
  provider = aws.us_east_1
  zone_id  = var.hosted_zone_id
  name     = "mail._domainkey.${local.mail_domain}"
  type     = "CNAME"
  ttl      = 300
  records  = ["mail.${local.mail_domain}._domainkey.amazonses.com"]
}

# Branded MX hostname — customers point their MX here instead of directly to
# the SES inbound endpoint. Customer creates: {their_domain} MX 10 mx.{mail_domain}
# RFC 2181 prefers A records as MX targets but CNAME chains work in practice
# with every major mail server.
resource "aws_route53_record" "ses_mx_host" {
  provider = aws.us_east_1
  zone_id  = var.hosted_zone_id
  name     = "mx.${local.mail_domain}"
  type     = "CNAME"
  ttl      = 300
  records  = ["inbound-smtp.eu-west-1.amazonaws.com"]
}

# Platform domain's own MX record — points to our branded hostname
resource "aws_route53_record" "ses_mx" {
  provider = aws.us_east_1
  zone_id  = var.hosted_zone_id
  name     = local.mail_domain
  type     = "MX"
  ttl      = 300
  records  = ["10 mx.${local.mail_domain}"]
}

# ---------------------------------------------------------------------------
# Bounce subdomain — SES custom MAIL FROM
# SPF lives here; customers CNAME bounce.{their} → bounce.{ours}.
# ---------------------------------------------------------------------------

# SES requires an MX record on the bounce subdomain pointing to its MAIL FROM endpoint
resource "aws_route53_record" "bounce_mx" {
  provider = aws.us_east_1
  zone_id  = var.hosted_zone_id
  name     = "bounce.${local.mail_domain}"
  type     = "MX"
  ttl      = 300
  records  = ["10 feedback-smtp.eu-west-1.amazonses.com"]
}

# SPF on the bounce subdomain — SES is the only authorised sender
resource "aws_route53_record" "bounce_spf" {
  provider = aws.us_east_1
  zone_id  = var.hosted_zone_id
  name     = "bounce.${local.mail_domain}"
  type     = "TXT"
  ttl      = 300
  records  = ["v=spf1 include:amazonses.com ~all"]
}

# ---------------------------------------------------------------------------
# DMARC — shared terminus; customers CNAME _dmarc.{their} → _dmarc.{ours}
# Resolvers follow CNAME chains for TXT queries, so no TXT record needed per customer.
# ---------------------------------------------------------------------------

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
