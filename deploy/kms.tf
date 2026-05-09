resource "aws_kms_key" "default" {
  description             = "${local.prefix} multi-region key"
  multi_region            = true
  enable_key_rotation     = false
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "default" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.default.key_id
}

resource "aws_kms_replica_key" "eu_central_1" {
  provider                = aws.eu_central_1
  primary_key_arn         = aws_kms_key.default.arn
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "eu_central_1" {
  provider      = aws.eu_central_1
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_replica_key.eu_central_1.key_id
}
