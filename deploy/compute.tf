# ---------------------------------------------------------------------------
# IAM role for Lambda
# ---------------------------------------------------------------------------

resource "aws_iam_role" "lambda" {
  name = "${var.service_name}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda_permissions" {
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CloudWatchLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
      },
      {
        Sid      = "S3ReadEmails"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.emails.arn}/emails/*"
      },
      {
        Sid    = "DynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem",
          "dynamodb:Scan"
        ]
        Resource = [
          aws_dynamodb_table.accounts.arn,
          "${aws_dynamodb_table.accounts.arn}/index/*",
          aws_dynamodb_table.signals.arn,
          "${aws_dynamodb_table.signals.arn}/index/*",
          aws_dynamodb_table.processing.arn,
          "${aws_dynamodb_table.processing.arn}/index/*",
          aws_dynamodb_table.audit.arn,
          "${aws_dynamodb_table.audit.arn}/index/*",
        ]
      },
      {
        Sid      = "WebSocketManage"
        Effect   = "Allow"
        Action   = ["execute-api:ManageConnections"]
        Resource = "${aws_apigatewayv2_api.ws.execution_arn}/*/@connections/*"
      },
      {
        Sid    = "BedrockInvoke"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/us.anthropic.claude-opus-4-5-20251101-v1:0",
          "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0"
        ]
      },
      {
        Sid    = "AuroraDataAPI"
        Effect = "Allow"
        Action = [
          "rds-data:ExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction",
        ]
        Resource = [for k, v in aws_rds_cluster.aurora : v.arn]
      },
      {
        Sid      = "SESSend"
        Effect   = "Allow"
        Action   = ["ses:SendEmail"]
        Resource = "*"
      },
      {
        Sid    = "SESSuppression"
        Effect = "Allow"
        Action = [
          "ses:PutSuppressedDestination",
          "ses:GetSuppressedDestination",
          "ses:ListSuppressedDestinations",
          "ses:DeleteSuppressedDestination",
        ]
        Resource = "*"
      },
      {
        Sid      = "SecretsManager"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [for k, v in aws_rds_cluster.aurora : v.master_user_secret[0].secret_arn]
      },
      {
        Sid      = "KMS"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource = data.aws_kms_alias.default.target_key_arn
      },
      {
        Sid      = "SQSReindexSend"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.reindex.arn
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch log group — created before the function so we control retention
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.service_name}-main"
  retention_in_days = 90
}

# ---------------------------------------------------------------------------
# Lambda function
# publish = true enables versioning; code and alias version are managed by CI
# ---------------------------------------------------------------------------

# Stub zip so the function can be created on first `tofu apply` before CI has run.
# CI replaces the code via aws-architect publishAndDeployStagePromise.
data "archive_file" "lambda_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/lambda-stub.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200, body: 'stub' });"
    filename = "handler.js"
  }
}

resource "aws_lambda_function" "main" {
  function_name = "${var.service_name}-main"
  role          = aws_iam_role.lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs24.x"
  memory_size   = 1024
  timeout       = 30
  publish       = true

  filename         = data.archive_file.lambda_stub.output_path
  source_code_hash = data.archive_file.lambda_stub.output_base64sha256

  environment {
    variables = {
      ACCOUNTS_TABLE        = aws_dynamodb_table.accounts.name
      SIGNALS_TABLE         = aws_dynamodb_table.signals.name
      PROCESSING_TABLE      = aws_dynamodb_table.processing.name
      AUDIT_TABLE           = aws_dynamodb_table.audit.name
      EMAIL_BUCKET          = aws_s3_bucket.emails.bucket
      AURORA_CLUSTER_ARN    = aws_rds_cluster.aurora["aurora-prod-titan-v2"].arn
      AURORA_SECRET_ARN     = aws_rds_cluster.aurora["aurora-prod-titan-v2"].master_user_secret[0].secret_arn
      AURORA_DB_NAME        = "signals"
      SES_CONFIGURATION_SET = aws_sesv2_configuration_set.sending.configuration_set_name
      WS_API_ENDPOINT       = "https://wss.${data.aws_route53_zone.main.name}"
      CF_ORIGIN_SECRET      = random_password.cf_origin_secret.result
      REINDEX_QUEUE_URL     = aws_sqs_queue.reindex.url
      MAIL_DOMAIN           = "platform.${data.aws_route53_zone.main.name}"
    }
  }

  logging_config {
    log_group  = aws_cloudwatch_log_group.lambda.name
    log_format = "Text"
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  # filename/source_code_hash are replaced by CI via aws-architect — tofu only manages the function skeleton
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ---------------------------------------------------------------------------
# Lambda alias — stable ARN for API Gateway + SQS triggers
# CI updates function_version after each deploy; tofu never touches it
# ---------------------------------------------------------------------------

resource "aws_lambda_alias" "production" {
  name             = "production"
  function_name    = aws_lambda_function.main.function_name
  function_version = aws_lambda_function.main.version

  lifecycle {
    ignore_changes = [function_version]
  }
}

# ---------------------------------------------------------------------------
# SQS → Lambda event source mappings (both point at alias)
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "signals" {
  event_source_arn                   = aws_sqs_queue.signals.arn
  function_name                      = aws_lambda_alias.production.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5

  function_response_types = ["ReportBatchItemFailures"]
}

# Bounce/complaint feedback events — processed by FeedbackProcessor
resource "aws_lambda_event_source_mapping" "feedback" {
  event_source_arn                   = aws_sqs_queue.feedback.arn
  function_name                      = aws_lambda_alias.production.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5

  function_response_types = ["ReportBatchItemFailures"]
}
# ---------------------------------------------------------------------------
# SQS queue for reindex jobs (no DLQ - indefinite retries with log escalation)
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "reindex" {
  name                       = "${var.service_name}-reindex"
  visibility_timeout_seconds = 900   # 15 minutes - longer than expected segment processing
  message_retention_seconds  = 345600 # 4 days

  # No redrive_policy - failed messages return to queue indefinitely
  # Idempotent worker handles every retry safely
  # Log-level escalation at 30 receives per _Strategy/conventions.md
}

resource "aws_sqs_queue_policy" "reindex_lambda" {
  queue_url = aws_sqs_queue.reindex.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.reindex.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "reindex" {
  event_source_arn                   = aws_sqs_queue.reindex.arn
  function_name                      = aws_lambda_alias.production.arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0

  function_response_types = ["ReportBatchItemFailures"]
}
