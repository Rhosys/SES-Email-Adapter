# ---------------------------------------------------------------------------
# External Mail Exchanges — webhook ingestion routes
# Provider-verified at application layer (JWT validation in handler code)
# ---------------------------------------------------------------------------

# resource "aws_apigatewayv2_route" "emx_webhook" {
#   api_id    = aws_apigatewayv2_api.main.id
#   route_key = "POST /external-exchanges/{platform}/target"
#   target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
#   # No authorization_type — provider-verified at application layer (OIDC JWT)
# }
