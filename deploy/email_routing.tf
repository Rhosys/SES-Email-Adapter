# ---------------------------------------------------------------------------
# SES receipt rule set and rules
# Domains are added by the API when users register them
# ---------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = "${var.service_name}-rules"
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
  scan_enabled  = true # Enable SES spam/virus scanning
  tls_policy    = "Require"
  recipients    = [] # Empty = matches all recipients

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
  email_identity         = data.aws_route53_zone.main.name
  configuration_set_name = aws_sesv2_configuration_set.sending.configuration_set_name

  # BYODKIM: one selector + private key works identically in every region.
  # Selector is "mail"; the matching public key is published via the CNAME below.
  dkim_signing_attributes {
    domain_signing_selector    = "mail"
    domain_signing_private_key = data.aws_kms_secrets.dkim.plaintext["private_key"]
  }

}

# Platform subdomain identity — independent from the root so either can move
# without breaking the other.
resource "aws_sesv2_email_identity" "platform" {
  email_identity         = "platform.${data.aws_route53_zone.main.name}"
  configuration_set_name = aws_sesv2_configuration_set.sending.configuration_set_name

  dkim_signing_attributes {
    domain_signing_selector    = "mail"
    domain_signing_private_key = data.aws_kms_secrets.dkim.plaintext["private_key"]
  }
}

# Custom MAIL FROM: SPF lives on the bounce subdomain so customers only need
# a CNAME (bounce.{their} → bounce.{ours}) instead of adding a TXT record.
# DMARC relaxed alignment still passes because bounce.{their} and {their}
# share the same organisational domain.
resource "aws_sesv2_email_identity_mail_from_attributes" "main" {
  email_identity   = aws_sesv2_email_identity.platform.email_identity
  mail_from_domain = "bounce.platform.${data.aws_route53_zone.main.name}"
}

# Custom MAIL FROM for the root identity (email.rhosys.cloud) — ensures
# noreply@email.rhosys.cloud passes SPF alignment via bounce.email.rhosys.cloud.
resource "aws_sesv2_email_identity_mail_from_attributes" "root" {
  email_identity   = aws_sesv2_email_identity.main.email_identity
  mail_from_domain = "bounce.${data.aws_route53_zone.main.name}"
}

# Shared DKIM terminus — all customer domains CNAME here instead of directly to
# amazonses.com. Because every customer domain is registered with the same BYODKIM
# private key, the public key served at this endpoint is valid for all of them.
# Customer creates: mail._domainkey.{their_domain} CNAME mail._domainkey.platform.{our_domain}
# Serves: platform domain AND healthcheck subdomain (both delegate DKIM here).
resource "aws_route53_record" "ses_dkim" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "mail._domainkey.platform.${data.aws_route53_zone.main.name}"
  type     = "TXT"
  ttl      = 300
  records  = [local.dkim_txt_record]
}

# DKIM for the root domain identity (email.rhosys.cloud) — verifies the SES
# identity so outbound mail from noreply@email.rhosys.cloud is DKIM-signed.
resource "aws_route53_record" "ses_dkim_root" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "mail._domainkey.${data.aws_route53_zone.main.name}"
  type     = "TXT"
  ttl      = 300
  records  = [local.dkim_txt_record]
}

# Branded MX hostname — customers point their MX here instead of directly to
# the SES inbound endpoint. Customer creates: {their_domain} MX 10 mx.{mail_domain}
# RFC 2181 prefers A records as MX targets but CNAME chains work in practice
# with every major mail server.
# Serves: platform domain AND healthcheck subdomain (both MX records resolve here).
resource "aws_route53_record" "ses_mx_host" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "mx.platform.${data.aws_route53_zone.main.name}"
  type     = "CNAME"
  ttl      = 300
  records  = ["inbound-smtp.${local.primary_region}.amazonaws.com"]
}

# Platform domain MX — routes inbound mail to the SES inbound endpoint via
# the branded hostname above. Serves: platform domain only (healthcheck
# subdomain has its own MX record).
resource "aws_route53_record" "platform_mx" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "platform.${data.aws_route53_zone.main.name}"
  type     = "MX"
  ttl      = 300
  records  = ["10 ${aws_route53_record.ses_mx_host.fqdn}"]
}

# ---------------------------------------------------------------------------
# Bounce subdomain — SES custom MAIL FROM
# SPF lives here; customers CNAME bounce.{their} → bounce.{ours}.
# ---------------------------------------------------------------------------

# SES requires an MX record on the bounce subdomain pointing to its MAIL FROM endpoint.
# Serves: platform domain AND healthcheck subdomain (both bounce CNAMEs resolve here).
resource "aws_route53_record" "bounce_mx" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "bounce.platform.${data.aws_route53_zone.main.name}"
  type     = "MX"
  ttl      = 300
  records  = ["10 feedback-smtp.${local.primary_region}.amazonses.com"]
}

# SPF on the bounce subdomain — SES is the only authorised sender.
# Serves: platform domain AND healthcheck subdomain (both bounce CNAMEs resolve here).
resource "aws_route53_record" "bounce_spf" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "bounce.platform.${data.aws_route53_zone.main.name}"
  type     = "TXT"
  ttl      = 300
  records  = ["v=spf1 include:amazonses.com ~all"]
}

# ---------------------------------------------------------------------------
# Bounce subdomain — root identity (bounce.email.rhosys.cloud)
# ---------------------------------------------------------------------------

resource "aws_route53_record" "bounce_mx_root" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "bounce.${data.aws_route53_zone.main.name}"
  type     = "MX"
  ttl      = 300
  records  = ["10 feedback-smtp.${local.primary_region}.amazonses.com"]
}

resource "aws_route53_record" "bounce_spf_root" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "bounce.${data.aws_route53_zone.main.name}"
  type     = "TXT"
  ttl      = 300
  records  = ["v=spf1 include:amazonses.com ~all"]
}

# ---------------------------------------------------------------------------
# DMARC — shared terminus; customers CNAME _dmarc.{their} → _dmarc.{ours}
# Resolvers follow CNAME chains for TXT queries, so no TXT record needed per customer.
# Serves: platform domain AND healthcheck subdomain (both delegate DMARC here).
# ---------------------------------------------------------------------------

resource "aws_route53_record" "dmarc" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "_dmarc.platform.${data.aws_route53_zone.main.name}"
  type     = "TXT"
  ttl      = 300
  records  = ["v=DMARC1;p=reject;pct=100"]
}

# ---------------------------------------------------------------------------
# SES Production: configuration set + bounce/complaint event destinations
# All outbound mail must reference this configuration set.
# ---------------------------------------------------------------------------

resource "aws_sesv2_configuration_set" "sending" {
  configuration_set_name = "${var.service_name}-sending"

  sending_options {
    sending_enabled = true
  }

  delivery_options {
    tls_policy        = "REQUIRE"
    sending_pool_name = aws_sesv2_dedicated_ip_pool.managed.pool_name
  }

  # Auto-suppress addresses that hard-bounce or complain — belt + suspenders
  # alongside our DynamoDB suppression list.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sns_topic" "ses_feedback" {
  name = "${var.service_name}-ses-feedback"
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

# ---------------------------------------------------------------------------
# SES Dedicated IP Pool (managed) — SES auto-provisions and scales IPs based
# on sending volume. Associated with the configuration set above so all
# outbound mail routes through dedicated IPs.
# ---------------------------------------------------------------------------

resource "aws_sesv2_dedicated_ip_pool" "managed" {
  pool_name    = "${lower(var.service_name)}-managed"
  scaling_mode = "MANAGED"

  tags = { Name = var.service_name }
}

# ---------------------------------------------------------------------------
# SES Tenant — platform identity. All mail sent from our own domains
# (noreply@, onboarding@) goes through this tenant. Customer domains get
# their own tenant created dynamically by the Lambda.
# ---------------------------------------------------------------------------

resource "aws_sesv2_tenant" "platform" {
  tenant_name = "${var.service_name}-platform"

  tags = { Name = var.service_name }
}

# Associate our platform identities + configuration set with the platform tenant
resource "aws_sesv2_tenant_resource_association" "platform_identity_main" {
  tenant_name  = aws_sesv2_tenant.platform.tenant_name
  resource_arn = aws_sesv2_email_identity.main.arn

  depends_on = [aws_sesv2_email_identity.main]
}

resource "aws_sesv2_tenant_resource_association" "platform_identity_subdomain" {
  tenant_name  = aws_sesv2_tenant.platform.tenant_name
  resource_arn = aws_sesv2_email_identity.platform.arn

  depends_on = [aws_sesv2_email_identity.platform]
}

resource "aws_sesv2_tenant_resource_association" "platform_config_set" {
  tenant_name  = aws_sesv2_tenant.platform.tenant_name
  resource_arn = aws_sesv2_configuration_set.sending.arn
}

# ---------------------------------------------------------------------------
# SES Tenant — SYSTEM. The healthcheck and other system-generated emails
# send with TenantName = "SYSTEM" (SYSTEM_ACCOUNT_ID). Without a matching
# tenant, SES rejects the send. Associate the same platform identities and
# configuration set so system mail routes correctly.
# ---------------------------------------------------------------------------

resource "aws_sesv2_tenant" "system" {
  tenant_name = "SYSTEM"

  tags = { Name = var.service_name }
}

resource "aws_sesv2_tenant_resource_association" "system_identity_main" {
  tenant_name  = aws_sesv2_tenant.system.tenant_name
  resource_arn = aws_sesv2_email_identity.main.arn

  depends_on = [aws_sesv2_email_identity.main]
}

resource "aws_sesv2_tenant_resource_association" "system_identity_subdomain" {
  tenant_name  = aws_sesv2_tenant.system.tenant_name
  resource_arn = aws_sesv2_email_identity.platform.arn

  depends_on = [aws_sesv2_email_identity.platform]
}

resource "aws_sesv2_tenant_resource_association" "system_config_set" {
  tenant_name  = aws_sesv2_tenant.system.tenant_name
  resource_arn = aws_sesv2_configuration_set.sending.arn
}

# ---------------------------------------------------------------------------
# Healthcheck subdomain — exercises the customer CNAME delegation pattern
# (MX + 3 CNAMEs) so the daily healthcheck validates the exact DNS code path
# customers rely on. All records serve the healthcheck subdomain only.
# ---------------------------------------------------------------------------

# Healthcheck subdomain MX — routes inbound healthcheck email through the same
# branded MX host used by customer domains. Serves: healthcheck subdomain only.
resource "aws_route53_record" "healthcheck_mx" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "healthcheck.platform.${data.aws_route53_zone.main.name}"
  type     = "MX"
  ttl      = 300
  records  = ["10 ${aws_route53_record.ses_mx_host.fqdn}"]
}

# Healthcheck DKIM CNAME — delegates to the platform DKIM terminus so
# checkDomain() can verify the delegation resolves correctly.
# Serves: healthcheck subdomain only (delegates to platform terminus).
resource "aws_route53_record" "healthcheck_dkim" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "mail._domainkey.healthcheck.platform.${data.aws_route53_zone.main.name}"
  type     = "CNAME"
  ttl      = 300
  records  = ["mail._domainkey.platform.${data.aws_route53_zone.main.name}"]
}

# Healthcheck bounce CNAME — delegates to the platform bounce SPF terminus.
# Serves: healthcheck subdomain only (delegates to platform terminus).
resource "aws_route53_record" "healthcheck_bounce" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "bounce.healthcheck.platform.${data.aws_route53_zone.main.name}"
  type     = "CNAME"
  ttl      = 300
  records  = ["bounce.platform.${data.aws_route53_zone.main.name}"]
}

# Healthcheck DMARC CNAME — delegates to the platform DMARC terminus.
# Serves: healthcheck subdomain only (delegates to platform terminus).
resource "aws_route53_record" "healthcheck_dmarc" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "_dmarc.healthcheck.platform.${data.aws_route53_zone.main.name}"
  type     = "CNAME"
  ttl      = 300
  records  = ["_dmarc.platform.${data.aws_route53_zone.main.name}"]
}

# Healthcheck subdomain SES identity — BYODKIM using the same signing key as
# the platform identity. Required so SES accepts outbound healthcheck email.
# Serves: healthcheck subdomain only.
resource "aws_sesv2_email_identity" "healthcheck" {
  email_identity         = "healthcheck.platform.${data.aws_route53_zone.main.name}"
  configuration_set_name = aws_sesv2_configuration_set.sending.configuration_set_name

  dkim_signing_attributes {
    domain_signing_selector    = "mail"
    domain_signing_private_key = data.aws_kms_secrets.dkim.plaintext["private_key"]
  }
}

# Associate healthcheck identity with the SYSTEM tenant so system-generated
# mail (TenantName = "SYSTEM") can send from the healthcheck subdomain.
# Serves: healthcheck subdomain only.
resource "aws_sesv2_tenant_resource_association" "system_identity_healthcheck" {
  tenant_name  = aws_sesv2_tenant.system.tenant_name
  resource_arn = aws_sesv2_email_identity.healthcheck.arn

  depends_on = [aws_sesv2_email_identity.healthcheck]
}
