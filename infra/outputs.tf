output "api_gateway_endpoint" {
  description = "Direct API Gateway endpoint (before CloudFront)"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "cloudfront_domain" {
  description = "CloudFront distribution domain name — point your DNS CNAME here"
  value       = aws_cloudfront_distribution.api.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation in CI)"
  value       = aws_cloudfront_distribution.api.id
}

output "lambda_function_name" {
  value = aws_lambda_function.main.function_name
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.main.name
}

output "email_bucket_name" {
  value = aws_s3_bucket.emails.name
}

output "signals_queue_url" {
  value = aws_sqs_queue.signals.url
}

output "signals_dlq_url" {
  description = "Dead-letter queue — monitor this for processing failures"
  value       = aws_sqs_queue.signals_dlq.url
}

output "rds_proxy_endpoint" {
  description = "RDS Proxy endpoint for Lambda to connect to Aurora"
  value       = aws_db_proxy.aurora.endpoint
}

output "aurora_cluster_identifier" {
  value = aws_rds_cluster.aurora.cluster_identifier
}

output "ses_rule_set_name" {
  value = aws_ses_receipt_rule_set.main.rule_set_name
}
