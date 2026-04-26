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

variable "app_name" {
  description = "Application name prefix for all resources"
  type        = string
  default     = "ses-email-adapter"
}

variable "api_domain" {
  description = "Custom domain for the API (e.g. api.yourdomain.com)"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 for the CloudFront distribution"
  type        = string
}

variable "lambda_s3_bucket" {
  description = "S3 bucket containing the Lambda deployment package"
  type        = string
}

variable "lambda_s3_key" {
  description = "S3 key of the Lambda deployment zip"
  type        = string
}

variable "lambda_memory_mb" {
  type    = number
  default = 1024
}

variable "lambda_timeout_seconds" {
  type    = number
  default = 30
}

variable "aurora_min_capacity" {
  description = "Minimum Aurora Serverless v2 capacity units"
  type        = number
  default     = 0.5
}

variable "aurora_max_capacity" {
  description = "Maximum Aurora Serverless v2 capacity units"
  type        = number
  default     = 4
}

variable "aurora_db_name" {
  type    = string
  default = "signals"
}

variable "aurora_master_username" {
  type    = string
  default = "admin"
}

variable "ses_rule_set_name" {
  description = "Name of the SES receipt rule set to activate"
  type        = string
  default     = "email-adapter-rules"
}

variable "notification_from_address" {
  description = "Verified SES email address used to send account notifications"
  type        = string
}

variable "aurora_db_username" {
  description = "Database username for the Lambda application user"
  type        = string
  default     = "lambda"
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
