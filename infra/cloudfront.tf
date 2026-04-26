# ---------------------------------------------------------------------------
# CloudFront distribution in front of API Gateway
# Region failover: update the origin domain to switch active region
# ---------------------------------------------------------------------------

locals {
  api_gateway_origin_id = "api-gateway"
}

# ---------------------------------------------------------------------------
# ACM certificate — must be in us-east-1 for CloudFront
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "api" {
  domain_name       = var.api_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.hosted_zone_id
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for record in aws_route53_record.acm_validation : record.fqdn]
}

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.prefix} API"
  price_class     = "PriceClass_100"  # US/EU only — expand for global

  aliases = [var.api_domain]

  origin {
    domain_name = replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")
    origin_id   = local.api_gateway_origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "x-origin-verify"
      value = random_password.cf_origin_secret.result
    }
  }

  default_cache_behavior {
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = local.api_gateway_origin_id
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type"]
      cookies { forward = "none" }
    }

    # Most API responses are not cacheable — let the app control via Cache-Control
    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 31536000

    compress = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.api.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# Secret shared between CloudFront and API Gateway to block direct access
resource "random_password" "cf_origin_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "cf_origin_secret" {
  name                    = "${local.prefix}/cloudfront/origin-secret"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "cf_origin_secret" {
  secret_id     = aws_secretsmanager_secret.cf_origin_secret.id
  secret_string = random_password.cf_origin_secret.result
}
