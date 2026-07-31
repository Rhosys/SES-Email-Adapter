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
# Hourly dispatcher — renews expiring provider subscriptions + catch-up sync
# ---------------------------------------------------------------------------

# resource "aws_cloudwatch_event_rule" "emx_dispatch" {
#   name                = "${var.service_name}-emx-dispatch"
#   description         = "Hourly EMX subscription renewal and catch-up sync"
#   schedule_expression = "rate(1 hour)"
# }

# resource "aws_cloudwatch_event_target" "emx_dispatch_sqs" {
#   rule = aws_cloudwatch_event_rule.emx_dispatch.name
#   arn  = aws_sqs_queue.main.arn
#
#   input = jsonencode({
#     messageType = "emx_dispatch"
#   })
# }

# resource "aws_sqs_queue_policy" "emx_dispatch_eventbridge" {
#   queue_url = aws_sqs_queue.main.id
#   policy = jsonencode({
#     Version = "2012-10-17"
#     Statement = [{
#       Effect    = "Allow"
#       Principal = { Service = "events.amazonaws.com" }
#       Action    = "sqs:SendMessage"
#       Resource  = aws_sqs_queue.main.arn
#       Condition = {
#         ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.emx_dispatch.arn }
#       }
#     }]
#   })
# }
