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
        Sid    = "SESNotifications"
        Effect = "Allow"
        Action = ["ses:SendEmail", "ses:SendRawEmail"]
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
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Lambda function
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "main" {
  function_name = "${local.prefix}-main"
  role          = aws_iam_role.lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs22.x"
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_seconds

  s3_bucket = var.lambda_s3_bucket
  s3_key    = var.lambda_s3_key

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
      AURORA_DB_NAME            = var.aurora_db_name
      DB_USER                   = var.aurora_db_username
      DB_PASSWORD               = var.aurora_db_password
      NOTIFICATION_FROM         = var.notification_from_address
      SES_CONFIGURATION_SET     = aws_sesv2_configuration_set.sending.configuration_set_name
      APP_BASE_URL              = var.app_base_url
      AUTHRESS_DOMAIN           = var.authress_domain
      AUTHRESS_APPLICATION_ID   = var.authress_application_id
    }
  }

  tracing_config {
    mode = "Active"
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${aws_lambda_function.main.function_name}"
  retention_in_days = 30
}

# ---------------------------------------------------------------------------
# SQS → Lambda event source mapping (signal processing)
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "signals" {
  event_source_arn                   = aws_sqs_queue.signals.arn
  function_name                      = aws_lambda_function.main.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5

  function_response_types = ["ReportBatchItemFailures"]
}

# Bounce/complaint feedback events — processed by FeedbackProcessor
resource "aws_lambda_event_source_mapping" "feedback" {
  event_source_arn                   = aws_sqs_queue.feedback.arn
  function_name                      = aws_lambda_function.main.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5

  function_response_types = ["ReportBatchItemFailures"]
}
