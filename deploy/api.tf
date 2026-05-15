# ---------------------------------------------------------------------------
# HTTP API Gateway (regional)
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "main" {
  name                         = "${var.service_name}-api"
  protocol_type                = "HTTP"
  disable_execute_api_endpoint = true
  ip_address_type              = "dualstack"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["HEAD", "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["Authorization", "Content-Type"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_alias.production.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "catch_all" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# ---------------------------------------------------------------------------
# Reindex operator API routes
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_route" "reindex_post" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /reindex"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "reindex_get" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /reindex/{jobId}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "main" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  default_route_settings {
    throttling_rate_limit  = 1000
    throttling_burst_limit = 500
  }
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${var.service_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.main.function_name
  qualifier     = aws_lambda_alias.production.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# WebSocket API Gateway
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "ws" {
  name                         = "${var.service_name}-ws"
  protocol_type                = "WEBSOCKET"
  route_selection_expression   = "$request.body.action"
  disable_execute_api_endpoint = true
  ip_address_type              = "dualstack"
}

resource "aws_apigatewayv2_integration" "ws_lambda" {
  api_id                    = aws_apigatewayv2_api.ws.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_alias.production.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_authorizer" "ws" {
  api_id           = aws_apigatewayv2_api.ws.id
  authorizer_type  = "REQUEST"
  authorizer_uri   = aws_lambda_alias.production.invoke_arn
  identity_sources = ["$request.querystring.token"]
  name             = "${var.service_name}-ws-authorizer"

  # Cache the Allow result per token for 5 minutes
  authorizer_result_ttl_in_seconds = 300
}

resource "aws_lambda_permission" "ws_authorizer" {
  statement_id  = "AllowWSAuthorizerInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.main.function_name
  qualifier     = aws_lambda_alias.production.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/authorizers/*"
}

resource "aws_apigatewayv2_route" "ws_connect" {
  api_id             = aws_apigatewayv2_api.ws.id
  route_key          = "$connect"
  target             = "integrations/${aws_apigatewayv2_integration.ws_lambda.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.ws.id
}

resource "aws_apigatewayv2_route" "ws_disconnect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_lambda.id}"
}

resource "aws_apigatewayv2_route" "ws_default" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.ws_lambda.id}"
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "production"
  auto_deploy = true
}

resource "aws_lambda_permission" "ws_gateway" {
  statement_id  = "AllowWSAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.main.function_name
  qualifier     = aws_lambda_alias.production.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# Custom domains — regional ACM cert + API Gateway domain names
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "api_gateways" {
  domain_name               = "api.${data.aws_route53_zone.main.name}"
  subject_alternative_names = ["wss.${data.aws_route53_zone.main.name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "api_gateways_cert_validation" {
  provider = aws.us_east_1
  # Keys must be statically known at plan time — use the domain names from config,
  # not from domain_validation_options (which is unknown while the cert is being created).
  for_each = toset([
    "api.${data.aws_route53_zone.main.name}",
    "wss.${data.aws_route53_zone.main.name}",
  ])

  allow_overwrite = true
  zone_id         = data.aws_route53_zone.main.zone_id
  name    = lookup({ for dvo in aws_acm_certificate.api_gateways.domain_validation_options : dvo.domain_name => dvo.resource_record_name }, each.key)
  type    = lookup({ for dvo in aws_acm_certificate.api_gateways.domain_validation_options : dvo.domain_name => dvo.resource_record_type }, each.key)
  records = [lookup({ for dvo in aws_acm_certificate.api_gateways.domain_validation_options : dvo.domain_name => dvo.resource_record_value }, each.key)]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "api_gateways" {
  certificate_arn         = aws_acm_certificate.api_gateways.arn
  validation_record_fqdns = [for record in aws_route53_record.api_gateways_cert_validation : record.fqdn]
}

# HTTP API custom domain — CloudFront origin points here
resource "aws_apigatewayv2_domain_name" "http" {
  domain_name = "api.${data.aws_route53_zone.main.name}"

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.api_gateways.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "http" {
  api_id      = aws_apigatewayv2_api.main.id
  domain_name = aws_apigatewayv2_domain_name.http.id
  stage       = aws_apigatewayv2_stage.main.id
}

# WebSocket API custom domain — clients connect directly
resource "aws_apigatewayv2_domain_name" "ws" {
  domain_name = "wss.${data.aws_route53_zone.main.name}"

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.api_gateways.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  domain_name = aws_apigatewayv2_domain_name.ws.id
  stage       = aws_apigatewayv2_stage.ws.id
}

# ---------------------------------------------------------------------------
# DNS — API Gateway custom domains (dualstack A + AAAA)
# api.email.rhosys.cloud is the CloudFront origin; not directly client-facing
# wss.email.rhosys.cloud is client-facing for WebSocket connections
# ---------------------------------------------------------------------------

resource "aws_route53_record" "api_gateway_a" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "api.${data.aws_route53_zone.main.name}"
  type     = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.http.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.http.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "api_gateway_aaaa" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "api.${data.aws_route53_zone.main.name}"
  type     = "AAAA"

  alias {
    name                   = aws_apigatewayv2_domain_name.http.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.http.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "ws_gateway_a" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "wss.${data.aws_route53_zone.main.name}"
  type     = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.ws.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.ws.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "ws_gateway_aaaa" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "wss.${data.aws_route53_zone.main.name}"
  type     = "AAAA"

  alias {
    name                   = aws_apigatewayv2_domain_name.ws.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.ws.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "api_gateway_https" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "api.${data.aws_route53_zone.main.name}"
  type     = "HTTPS"
  ttl      = 300
  records  = ["1 . alpn=\"h2\""]
}

resource "aws_route53_record" "ws_gateway_https" {
  provider = aws.us_east_1
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "wss.${data.aws_route53_zone.main.name}"
  type     = "HTTPS"
  ttl      = 300
  records  = ["1 . alpn=\"h2\""]
}
