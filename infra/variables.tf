variable "aws_account_id" {
  description = "AWS account ID — guards against applying to the wrong account. Inject via TF_VAR_aws_account_id."
  type        = string
}

variable "env" {
  description = "Environment (prod, staging, dev)"
  type        = string
}

variable "api_domain" {
  description = "Custom domain for the API (e.g. api.yourdomain.com)"
  type        = string
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID for api_domain — used for ACM DNS validation and CloudFront alias record"
  type        = string
}

variable "notification_from_address" {
  description = "Verified SES email address used to send account notifications"
  type        = string
}

variable "app_base_url" {
  description = "Base URL of the frontend app, used in notification email links"
  type        = string
}
