variable "aws_account_id" {
  description = "AWS account ID — guards against applying to the wrong account. Inject via TF_VAR_aws_account_id."
  type        = string
}

variable "env" {
  description = "Environment (prod, staging, dev)"
  type        = string
}

variable "aws_region" {
  description = "Primary AWS region"
  type        = string
  default     = "us-east-1"
}

variable "api_domain" {
  description = "Custom domain for the API (e.g. api.yourdomain.com)"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 for the CloudFront distribution"
  type        = string
}

variable "notification_from_address" {
  description = "Verified SES email address used to send account notifications"
  type        = string
}

variable "aurora_db_password" {
  description = "Database password for the Lambda application user (use Secrets Manager in production)"
  type        = string
  sensitive   = true
}

variable "app_base_url" {
  description = "Base URL of the frontend app, used in notification email links"
  type        = string
}

variable "authress_domain" {
  description = "Authress custom domain (e.g. auth.yourdomain.com)"
  type        = string
}

variable "authress_application_id" {
  description = "Authress application ID for JWT audience validation"
  type        = string
}
