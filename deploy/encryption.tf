# KMS key is owned by the email-catcher/infrastructure repo.
# Look it up by alias — no need to create it here.

data "aws_kms_alias" "default" {
  name = "alias/default"
}
