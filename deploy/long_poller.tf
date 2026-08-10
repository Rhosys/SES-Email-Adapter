# ---------------------------------------------------------------------------
# Long Poller — separate Lambda for IMAP IDLE / JMAP long-polling (5+ min)
# Same code artifact as main, different handler, 15-minute timeout
# Reuses the main Lambda IAM role (same permissions needed)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# SQS queue — long-poller messages
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "long_poller" {
  name                       = "${var.service_name}-long-poller"
  visibility_timeout_seconds = 1800    # 30 minutes (2× Lambda timeout)
  message_retention_seconds  = 1209600 # 14 days
}

# ---------------------------------------------------------------------------
# Lambda function — long-poller
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "long_poller" {
  function_name = "${var.service_name}-long-poller"
  role          = aws_iam_role.lambda.arn
  handler       = "long-poller.handler"
  runtime       = "nodejs24.x"
  memory_size   = 128
  timeout       = 900 # 15 minutes (maximum Lambda timeout)
  publish       = true

  filename         = data.archive_file.lambda_stub.output_path
  source_code_hash = data.archive_file.lambda_stub.output_base64sha256

  environment {
    variables = {
      AWS_ACCOUNT_ID   = var.aws_account_id
      ACCOUNTS_TABLE   = aws_dynamodb_table.accounts.name
      SIGNAL_QUEUE_URL = aws_sqs_queue.signals.url
      NODE_OPTIONS     = "--enable-source-maps"
    }
  }

  logging_config {
    log_group  = aws_cloudwatch_log_group.shared.name
    log_format = "JSON"
  }

  depends_on = [aws_cloudwatch_log_group.shared]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ---------------------------------------------------------------------------
# Lambda alias — stable ARN for SQS trigger
# ---------------------------------------------------------------------------

resource "aws_lambda_alias" "long_poller_production" {
  name             = "production"
  function_name    = aws_lambda_function.long_poller.function_name
  function_version = aws_lambda_function.long_poller.version

  lifecycle {
    ignore_changes = [function_version]
  }
}

# ---------------------------------------------------------------------------
# SQS → Lambda event source mapping (batch size 1 — one account per invocation)
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "long_poller" {
  event_source_arn = aws_sqs_queue.long_poller.arn
  function_name    = aws_lambda_alias.long_poller_production.arn
  batch_size       = 1

  function_response_types = ["ReportBatchItemFailures"]
}
