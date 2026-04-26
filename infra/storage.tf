# ---------------------------------------------------------------------------
# S3 — raw inbound email storage
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "emails" {
  bucket = "${local.prefix}-emails"
}

resource "aws_s3_bucket_lifecycle_configuration" "emails" {
  bucket = aws_s3_bucket.emails.id

  rule {
    id     = "expire-raw-emails"
    status = "Enabled"

    filter { prefix = "emails/" }

    expiration {
      # Raw MIME stored for 90 days; processed content lives in DynamoDB
      days = 90
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "emails" {
  bucket = aws_s3_bucket.emails.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "emails" {
  bucket                  = aws_s3_bucket.emails.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Allow SES to write to the bucket
resource "aws_s3_bucket_policy" "emails" {
  bucket = aws_s3_bucket.emails.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSESPut"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.emails.arn}/emails/*"
      Condition = {
        StringEquals = { "aws:Referer" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# SQS — signal processing queue
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "signals_dlq" {
  name                      = "${local.prefix}-signals-dlq"
  message_retention_seconds = 1209600  # 14 days
}

resource "aws_sqs_queue" "signals" {
  name                       = "${local.prefix}-signals"
  visibility_timeout_seconds = var.lambda_timeout_seconds * 6  # 6x Lambda timeout
  message_retention_seconds  = 86400  # 1 day

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.signals_dlq.arn
    maxReceiveCount     = 3
  })
}

# SNS topic that SES notifies after storing to S3
resource "aws_sns_topic" "ses_notifications" {
  name = "${local.prefix}-ses-notifications"
}

resource "aws_sns_topic_subscription" "ses_to_sqs" {
  topic_arn = aws_sns_topic.ses_notifications.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.signals.arn
}

resource "aws_sqs_queue_policy" "signals_sns" {
  queue_url = aws_sqs_queue.signals.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.signals.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.ses_notifications.arn } }
    }]
  })
}

# ---------------------------------------------------------------------------
# SQS — bounce/complaint feedback processing queue
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "feedback" {
  name                       = "${local.prefix}-feedback"
  visibility_timeout_seconds = var.lambda_timeout_seconds * 6
  message_retention_seconds  = 86400  # 1 day

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.signals_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sns_topic_subscription" "feedback_to_sqs" {
  topic_arn = aws_sns_topic.ses_feedback.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.feedback.arn
}

resource "aws_sqs_queue_policy" "feedback_sns" {
  queue_url = aws_sqs_queue.feedback.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.feedback.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.ses_feedback.arn } }
    }]
  })
}

# ---------------------------------------------------------------------------
# DynamoDB — three tables: accounts, signals, processing
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "accounts" {
  name         = "${local.prefix}-accounts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute { name = "pk"; type = "S" }
  attribute { name = "sk"; type = "S" }

  point_in_time_recovery { enabled = true }
  deletion_protection_enabled = true

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"
}

resource "aws_dynamodb_table" "signals" {
  name         = "${local.prefix}-signals"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute { name = "pk"; type = "S" }
  attribute { name = "sk"; type = "S" }
  attribute { name = "gsi1pk"; type = "S" }
  attribute { name = "gsi1sk"; type = "S" }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
  deletion_protection_enabled = true

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"
}

resource "aws_dynamodb_table" "processing" {
  name         = "${local.prefix}-processing"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute { name = "pk"; type = "S" }
  attribute { name = "sk"; type = "S" }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  deletion_protection_enabled = true
}
