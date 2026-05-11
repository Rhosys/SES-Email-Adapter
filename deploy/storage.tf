# ---------------------------------------------------------------------------
# S3 — raw inbound email storage
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "emails" {
  bucket           = "${lower(var.service_name)}-emails-${var.aws_account_id}-eu-west-1-an"
  bucket_namespace = "account-regional"
}

resource "aws_s3_bucket_lifecycle_configuration" "emails" {
  bucket = aws_s3_bucket.emails.id

  # Rule 1: free-tier 1-year expiry (only applies to objects tagged retention-tier=P1Y)
  rule {
    id     = "inbox-free-tier-1yr"
    status = "Enabled"
    filter {
      and {
        prefix = "inbox/"
        tags = {
          "retention-tier" = "P1Y"
        }
      }
    }
    expiration { days = 365 }
  }

  # Rule 2: default 5-year expiry on the inbox prefix (applies to all inbox/ objects)
  # When both rules apply, S3 takes the shorter expiration — so free-tier objects (tagged) expire at 365 days, paid-tier (untagged) at 1825 days.
  rule {
    id     = "inbox-default-5yr"
    status = "Enabled"
    filter {
      prefix = "inbox/"
    }
    expiration { days = 1825 }
  }

  # No rule for saved/ — objects there have no lifecycle expiration.
}

resource "aws_s3_bucket_server_side_encryption_configuration" "emails" {
  bucket = aws_s3_bucket.emails.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
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
        StringEquals = { "aws:Referer" = var.aws_account_id }
      }
    }]
  })
}


# ---------------------------------------------------------------------------
# SQS — signal processing queue
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "signals" {
  name                       = "${var.service_name}-signals"
  visibility_timeout_seconds = 900    # match expected worker runtime
  message_retention_seconds  = 1209600 # 14 days (maximum)
}

# SNS topic that SES notifies after storing to S3
resource "aws_sns_topic" "ses_notifications" {
  name = "${var.service_name}-ses-notifications"
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
  name                       = "${var.service_name}-feedback"
  visibility_timeout_seconds = 900    # match expected worker runtime
  message_retention_seconds  = 1209600 # 14 days (maximum)
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
  name         = "${var.service_name}-accounts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  point_in_time_recovery { enabled = true }
  deletion_protection_enabled = true

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  replica {
    region_name = "eu-central-1"
  }
}

resource "aws_dynamodb_table" "signals" {
  name         = "${var.service_name}-signals"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
  deletion_protection_enabled = true

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  replica {
    region_name = "eu-central-1"
  }
}

resource "aws_dynamodb_table" "processing" {
  name         = "${var.service_name}-processing"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
  deletion_protection_enabled = true

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  replica {
    region_name = "eu-central-1"
  }
}

resource "aws_dynamodb_table" "audit" {
  name         = "${var.service_name}-audit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
  deletion_protection_enabled = true
}

# ---------------------------------------------------------------------------
# EventBridge — weekly domain health check
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "domain_health" {
  name                = "${var.service_name}-domain-health"
  description         = "Weekly DNS health check for all registered domains"
  schedule_expression = "cron(0 6 ? * MON *)"
}

resource "aws_cloudwatch_event_target" "domain_health" {
  rule      = aws_cloudwatch_event_rule.domain_health.name
  target_id = "domain-health-lambda"
  arn       = aws_lambda_alias.production.arn

  input = jsonencode({ source = "domain-health-job" })
}

resource "aws_lambda_permission" "domain_health_eventbridge" {
  statement_id  = "AllowDomainHealthEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.main.function_name
  qualifier     = aws_lambda_alias.production.name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.domain_health.arn
}
