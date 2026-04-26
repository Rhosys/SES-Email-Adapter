# ---------------------------------------------------------------------------
# IAM role for Lambda
# ---------------------------------------------------------------------------

resource "aws_iam_role" "lambda" {
  name = "${local.prefix}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda_permissions" {
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
      },
      {
        Sid    = "S3ReadEmails"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.emails.arn}/emails/*"
      },
      {
        Sid    = "DynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem"
        ]
        Resource = [
          aws_dynamodb_table.accounts.arn,
          "${aws_dynamodb_table.accounts.arn}/index/*",
          aws_dynamodb_table.signals.arn,
          "${aws_dynamodb_table.signals.arn}/index/*",
          aws_dynamodb_table.processing.arn,
          "${aws_dynamodb_table.processing.arn}/index/*",
        ]
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
        Sid    = "RdsProxyConnect"
        Effect = "Allow"
        Action = ["rds-db:connect"]
        Resource = "arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_proxy.aurora.id}/*"
      },
      {
        Sid    = "SESSend"
        Effect = "Allow"
        Action = ["ses:SendEmail"]
        Resource = "*"
        Condition = {
          StringEquals = { "ses:FromAddress" = var.notification_from_address }
        }
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
        Sid    = "SecretsManager"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${local.prefix}/*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch log group — created before the function so we control retention
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.prefix}-main"
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
  function_name    = "${local.prefix}-main"
  role             = aws_iam_role.lambda.arn
  handler          = "handler.handler"
  runtime          = "nodejs22.x"
  memory_size      = 1024
  timeout          = 30
  publish          = true

  filename         = data.archive_file.lambda_stub.output_path
  source_code_hash = data.archive_file.lambda_stub.output_base64sha256

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      NODE_ENV                  = var.env
      ACCOUNTS_TABLE            = aws_dynamodb_table.accounts.name
      SIGNALS_TABLE             = aws_dynamodb_table.signals.name
      PROCESSING_TABLE          = aws_dynamodb_table.processing.name
      EMAIL_BUCKET              = aws_s3_bucket.emails.name
      RDS_PROXY_ENDPOINT        = aws_db_proxy.aurora.endpoint
      AURORA_DB_NAME            = "signals"
      DB_USER                   = "lambda"
      NOTIFICATION_FROM         = var.notification_from_address
      SES_CONFIGURATION_SET     = aws_sesv2_configuration_set.sending.configuration_set_name
      APP_BASE_URL              = var.app_base_url
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
