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

# ---------------------------------------------------------------------------
# EMX dispatch — renews expiring provider subscriptions + catch-up sync
# ---------------------------------------------------------------------------

resource "aws_scheduler_schedule" "emx_dispatch" {
  name       = "${var.service_name}-emx-dispatch"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "rate(15 minutes)"
  schedule_expression_timezone = "UTC"

  target {
    arn      = aws_sqs_queue.signals.arn
    role_arn = aws_iam_role.scheduler_sqs.arn

    input = jsonencode({
      sqsMessageAttributeMessageType = "emx_dispatch"
    })
  }
}
