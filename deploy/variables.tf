variable "aws_account_id" {
  description = "AWS account ID — guards against applying to the wrong account. Inject via TF_VAR_aws_account_id."
  type        = string
}

variable "service_name" {
  description = "Service name — canonical identity, matches deployed resource names"
  type        = string
  default     = "SES-Email-Adapter"
}
