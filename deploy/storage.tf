# ---------------------------------------------------------------------------
# S3 — raw inbound email storage
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "emails" {
  bucket           = "${lower(var.service_name)}-emails-${var.aws_account_id}-${local.primary_region}-an"
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

resource "aws_s3_bucket_cors_configuration" "emails" {
  bucket = aws_s3_bucket.emails.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET"]
    allowed_origins = ["https://email.rhosys.cloud"]
    expose_headers  = ["Content-Type"]
    max_age_seconds = 3600
  }
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
  visibility_timeout_seconds = 120     # 2× Lambda timeout (60s)
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

resource "aws_sns_topic_subscription" "feedback_to_sqs" {
  topic_arn = aws_sns_topic.ses_feedback.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.signals.arn
}

resource "aws_sqs_queue_policy" "signals_sns" {
  queue_url = aws_sqs_queue.signals.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowSNSSend"
        Effect    = "Allow"
        Principal = { Service = "sns.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.signals.arn
        Condition = { ArnEquals = { "aws:SourceArn" = [
          aws_sns_topic.ses_notifications.arn,
          aws_sns_topic.ses_feedback.arn,
        ] } }
      },
      {
        Sid       = "AllowSchedulerSend"
        Effect    = "Allow"
        Principal = { Service = "scheduler.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.signals.arn
        Condition = { ArnEquals = { "aws:SourceArn" = [
          "arn:aws:scheduler:*:${var.aws_account_id}:schedule/signal-followups/*",
          aws_scheduler_schedule.digest_dispatch.arn,
        ] } }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# EventBridge Scheduler — follow-up schedule group + IAM
# ---------------------------------------------------------------------------

resource "aws_scheduler_schedule_group" "followups" {
  name = "signal-followups"
}

resource "aws_iam_role" "scheduler_sqs" {
  name = "${var.service_name}-scheduler-sqs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_sqs_send" {
  role = aws_iam_role.scheduler_sqs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.signals.arn
    }]
  })
}

# ---------------------------------------------------------------------------
# EventBridge Scheduler — daily digest dispatch (08:00 UTC)
# ---------------------------------------------------------------------------

resource "aws_scheduler_schedule" "digest_dispatch" {
  name       = "${var.service_name}-digest-dispatch"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(0 8 * * ? *)"
  schedule_expression_timezone = "UTC"

  target {
    arn      = aws_sqs_queue.signals.arn
    role_arn = aws_iam_role.scheduler_sqs.arn

    input = jsonencode({
      sqsMessageAttributeMessageType = "digest_dispatch"
    })
  }
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

  replica { region_name = "eu-central-2" }
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
  attribute {
    name = "gsi3pk"
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

  global_secondary_index {
    name            = "gsi3"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi3pk"
      key_type       = "HASH"
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

  replica { region_name = "eu-central-2" }
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

  replica { region_name = "eu-central-2" }
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

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  point_in_time_recovery { enabled = true }
  deletion_protection_enabled = true

  replica { region_name = "eu-central-2" }
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
}

resource "aws_lambda_permission" "domain_health_eventbridge" {
  statement_id  = "AllowDomainHealthEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.main.function_name
  qualifier     = aws_lambda_alias.production.name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.domain_health.arn
}
