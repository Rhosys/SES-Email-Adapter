data "aws_caller_identity" "current" {}

resource "aws_kms_key" "default" {
  description             = "${local.prefix} multi-region key"
  multi_region            = true
  enable_key_rotation     = false
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AccountRootAdmin"
        Effect = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        # S3 calls KMS on behalf of SES when writing encrypted email objects
        Sid    = "AllowSESviaS3"
        Effect = "Allow"
        Principal = { Service = "s3.amazonaws.com" }
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = "*"
      },
      {
        Sid    = "AllowLambda"
        Effect = "Allow"
        Principal = { AWS = aws_iam_role.lambda.arn }
        Action   = ["kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource = "*"
      },
    ]
  })
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
