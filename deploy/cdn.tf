# ---------------------------------------------------------------------------
# CloudFront distribution in front of API Gateway
# Region failover: update the origin domain to switch active region
# ---------------------------------------------------------------------------

locals {
  api_gateway_origin_id = "api-gateway"
  s3_site_origin_id     = "s3-site"
  s3_assets_origin_id   = "s3-site-assets"
  site_version          = "main/2026"
}

# ---------------------------------------------------------------------------
# ACM certificate — must be in us-east-1 for CloudFront
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "api" {
  provider          = aws.us_east_1
  domain_name       = data.aws_route53_zone.main.name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "acm_validation" {
  provider = aws.us_east_1
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
  zone_id         = data.aws_route53_zone.main.zone_id
}

resource "aws_acm_certificate_validation" "api" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for record in aws_route53_record.acm_validation : record.fqdn]
}

resource "aws_cloudfront_distribution" "api" {
  provider        = aws.us_east_1
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.service_name} API"
  price_class     = "PriceClass_100" # US/EU only — expand for global

  aliases = [data.aws_route53_zone.main.name]

  # S3 origin — static site assets via OAC
  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = local.s3_site_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  # S3 origin — versioned assets with origin_path (no function needed)
  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = local.s3_assets_origin_id
    origin_path              = "/${local.site_version}"
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  # API Gateway origin — existing API with x-origin-verify secret
  origin {
    domain_name = aws_apigatewayv2_domain_name.http.domain_name
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

  # Default behavior — S3 static site with SPA rewrite
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = local.s3_site_origin_id
    cache_policy_id        = aws_cloudfront_cache_policy.s3_cache.id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  # /assets/* — S3 immutable hashed assets (no SPA rewrite)
  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = local.s3_assets_origin_id
    cache_policy_id        = aws_cloudfront_cache_policy.assets_cache.id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
  }

  # /api/* — API Gateway origin (all methods, no caching by default)
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = local.api_gateway_origin_id
    cache_policy_id        = aws_cloudfront_cache_policy.api_cache.id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
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

resource "aws_route53_record" "api" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = data.aws_route53_zone.main.name
  type     = "A"

  alias {
    name                   = aws_cloudfront_distribution.api.domain_name
    zone_id                = aws_cloudfront_distribution.api.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "api_aaaa" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = data.aws_route53_zone.main.name
  type     = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.api.domain_name
    zone_id                = aws_cloudfront_distribution.api.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "api_https" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = data.aws_route53_zone.main.name
  type     = "HTTPS"
  ttl      = 300
  records  = ["1 . alpn=\"h2\""]
}

# Secret shared between CloudFront and API Gateway to block direct access
resource "random_password" "cf_origin_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "cf_origin_secret" {
  name                    = "${var.service_name}/cloudfront/origin-secret"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "cf_origin_secret" {
  secret_id     = aws_secretsmanager_secret.cf_origin_secret.id
  secret_string = random_password.cf_origin_secret.result
}

# ---------------------------------------------------------------------------
# S3 — static site assets (front-end)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "web" {
  bucket           = "${lower(var.service_name)}-web-${var.aws_account_id}-eu-west-1-an"
  bucket_namespace = "account-regional"
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

# ---------------------------------------------------------------------------
# CloudFront Origin Access Control — S3
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${var.service_name}-s3-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.api.arn }
      }
    }]
  })
}

# ---------------------------------------------------------------------------
# CloudFront Cache Policies
# ---------------------------------------------------------------------------

resource "aws_cloudfront_cache_policy" "s3_cache" {
  name        = "${var.service_name}-s3-cache"
  default_ttl = 86400
  max_ttl     = 31536000
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

resource "aws_cloudfront_cache_policy" "assets_cache" {
  name        = "${var.service_name}-assets-cache"
  default_ttl = 31536000
  max_ttl     = 31536000
  min_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

resource "aws_cloudfront_cache_policy" "api_cache" {
  name        = "${var.service_name}-api-cache"
  default_ttl = 0
  max_ttl     = 31536000
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "whitelist"
      cookies { items = ["authorization"] }
    }
    headers_config {
      header_behavior = "whitelist"
      headers { items = ["Authorization", "Content-Type", "Origin", "Accept"] }
    }
    query_strings_config {
      query_string_behavior = "all"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

# ---------------------------------------------------------------------------
# CloudFront Function — SPA rewrite (viewer-request)
# ---------------------------------------------------------------------------

resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${var.service_name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-EOF
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var MAIN_PREFIX = '/${local.site_version}';

  // Bare /pr with no trailing slash — pass through unchanged
  if (uri === '/pr') {
    return request;
  }

  // PR preview prefix — rewrite SPA routes to prefix-scoped index.html
  if (uri.startsWith('/pr/')) {
    var segments = uri.split('/');
    // segments: ['', 'pr', slug, ...rest]
    var slug = segments[2];

    if (!slug) {
      return request;
    }

    var lastSegment = segments[segments.length - 1];
    if (lastSegment.includes('.')) {
      return request;
    }

    request.uri = '/pr/' + slug + '/index.html';
    return request;
  }

  // Root-level requests: prepend site_version prefix
  var lastSeg = uri.substring(uri.lastIndexOf('/') + 1);
  if (!lastSeg.includes('.')) {
    request.uri = MAIN_PREFIX + '/index.html';
  } else {
    request.uri = MAIN_PREFIX + uri;
  }

  return request;
}
EOF
}
