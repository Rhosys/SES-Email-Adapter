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

output "user_code_executor_function_name" {
  value = aws_lambda_function.user_code_executor.function_name
}

output "content_sanitizer_function_name" {
  value = aws_lambda_function.content_sanitizer.function_name
}

output "dynamodb_accounts_table" {
  value = aws_dynamodb_table.accounts.name
}

output "dynamodb_signals_table" {
  value = aws_dynamodb_table.signals.name
}

output "dynamodb_processing_table" {
  value = aws_dynamodb_table.processing.name
}

output "site_bucket_name" {
  description = "S3 bucket name for static site assets (for CI sync)"
  value       = aws_s3_bucket.web.bucket
}

output "site_bucket_arn" {
  description = "S3 bucket ARN for static site assets (for CI IAM policies)"
  value       = aws_s3_bucket.web.arn
}

output "email_bucket_name" {
  description = "S3 bucket name for email storage (account-regional format)"
  value       = aws_s3_bucket.emails.bucket
}

output "signals_queue_url" {
  value = aws_sqs_queue.signals.url
}

output "aurora_cluster_identifiers" {
  description = "Aurora cluster identifiers keyed by cluster registry ID"
  value       = { for k, v in aws_rds_cluster.aurora : k => v.cluster_identifier }
}

output "ses_rule_set_name" {
  value = aws_ses_receipt_rule_set.main.rule_set_name
}

output "dynamodb_audit_table" {
  value = aws_dynamodb_table.audit.name
}

output "ws_api_endpoint" {
  description = "WebSocket API endpoint — clients connect to wss://wss.email.rhosys.cloud"
  value       = "wss://wss.${data.aws_route53_zone.main.name}"
}

output "authress_service_client_public_key" {
  description = "Base64 DER public key for Authress service client registration (POST /v1/clients/{clientId}/access-keys)"
  value       = data.aws_kms_public_key.authress_service_client.public_key
}
