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
        Resource = "${aws_cloudwatch_log_group.shared.arn}:*"
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
          "arn:aws:bedrock:*::foundation-model/*",
          # Cross-region inference profiles (eu.*/us.* model IDs) are account-scoped
          # resources with a different ARN pattern than foundation models
          "arn:aws:bedrock:*:*:inference-profile/*"
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
        Sid    = "SESIdentity"
        Effect = "Allow"
        Action = [
          "ses:CreateEmailIdentity",
          "ses:DeleteEmailIdentity",
          "ses:PutEmailIdentityMailFromAttributes",
          "ses:TagResource",
        ]
        Resource = "*"
      },
      {
        Sid    = "SESTenant"
        Effect = "Allow"
        Action = [
          "ses:CreateTenant",
          "ses:DeleteTenant",
          "ses:GetTenant",
          "ses:CreateTenantResourceAssociation",
          "ses:DeleteTenantResourceAssociation",
        ]
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
        Sid      = "KMSAuthressSign"
        Effect   = "Allow"
        Action   = ["kms:Sign"]
        Resource = aws_kms_key.authress_service_client.arn
      },
      {
        Sid      = "SQSSend"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.signals.arn
      },
      {
        Sid      = "SQSConsume"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.signals.arn
      },
      {
        Sid      = "StepFunctionsStart"
        Effect   = "Allow"
        Action   = ["states:StartExecution"]
        Resource = aws_sfn_state_machine.account_creation.arn
      },
      {
        Sid    = "InvokeIsolatedLambdas"
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        Resource = [
          aws_lambda_function.user_code_executor.arn,
          aws_lambda_function.content_sanitizer.arn,
        ]
      },
      {
        Sid      = "S3ExtractedContentWrite"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:PutObjectTagging"]
        Resource = "${aws_s3_bucket.extracted_content.arn}/*"
      },
      {
        Sid    = "EventBridgeScheduler"
        Effect = "Allow"
        Action = [
          "scheduler:CreateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
          "scheduler:ListSchedules",
        ]
        Resource = [
          aws_scheduler_schedule_group.followups.arn,
          "arn:aws:scheduler:*:*:schedule/signal-followups/*",
        ]
      },
      {
        Sid      = "PassSchedulerRole"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = aws_iam_role.scheduler_sqs.arn
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch log group — shared by all Lambda functions in this service
# (replaces per-function log groups; old groups left for manual deletion)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "shared" {
  name              = "/aws/lambda/${var.service_name}"
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
  timeout       = 60
  publish       = true

  filename         = data.archive_file.lambda_stub.output_path
  source_code_hash = data.archive_file.lambda_stub.output_base64sha256

  environment {
    variables = {
      AWS_ACCOUNT_ID           = var.aws_account_id
      ACCOUNTS_TABLE           = aws_dynamodb_table.accounts.name
      SIGNALS_TABLE            = aws_dynamodb_table.signals.name
      PROCESSING_TABLE         = aws_dynamodb_table.processing.name
      AUDIT_TABLE              = aws_dynamodb_table.audit.name
      EMAIL_BUCKET             = aws_s3_bucket.emails.bucket
      AURORA_CLUSTER_ARN       = aws_rds_cluster.aurora["aurora-prod-titan-v2"].arn
      AURORA_SECRET_ARN        = aws_rds_cluster.aurora["aurora-prod-titan-v2"].master_user_secret[0].secret_arn
      AURORA_DB_NAME           = "signals"
      SES_CONFIGURATION_SET_ARN = aws_sesv2_configuration_set.sending.arn
      WS_API_ENDPOINT          = "https://wss.${data.aws_route53_zone.main.name}"
      CF_ORIGIN_SECRET         = random_password.cf_origin_secret.result
      SIGNAL_QUEUE_URL         = aws_sqs_queue.signals.url
      MAIL_DOMAIN              = "platform.${data.aws_route53_zone.main.name}"
      DKIM_PRIVATE_KEY         = data.aws_kms_secrets.dkim.plaintext["private_key"]
      # Pass only the name — the Lambda constructs the ARN at runtime from
      # AWS_REGION + own account ID. Cannot reference aws_sfn_state_machine here
      # because the SFN calls this Lambda (circular dependency).
      ACCOUNT_CREATION_SFN_NAME = "email-catcher-AccountCreation"
      AUTHRESS_KMS_KEY_ARN     = aws_kms_key.authress_service_client.arn
      AUTHRESS_KEY_ID          = "AaWE"
      USER_CODE_EXECUTOR_ARN   = aws_lambda_function.user_code_executor.arn
      CONTENT_SANITIZER_ARN    = aws_lambda_function.content_sanitizer.arn
      CONTENT_BUCKET           = aws_s3_bucket.extracted_content.bucket
      CONTENT_CDN_BASE_URL     = "https://${aws_cloudfront_distribution.api.domain_name}"
      SCHEDULER_GROUP_NAME     = aws_scheduler_schedule_group.followups.name
      SCHEDULER_ROLE_ARN       = aws_iam_role.scheduler_sqs.arn
      SIGNAL_QUEUE_ARN         = aws_sqs_queue.signals.arn
      SES_REGION               = local.primary_region
      NODE_OPTIONS             = "--enable-source-maps"
    }
  }

  logging_config {
    log_group  = aws_cloudwatch_log_group.shared.name
    log_format = "JSON"
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.shared]

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
# SQS → Lambda event source mapping
# ---------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "signals" {
  event_source_arn                   = aws_sqs_queue.signals.arn
  function_name                      = aws_lambda_alias.production.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5

  function_response_types = ["ReportBatchItemFailures"]
}

# ---------------------------------------------------------------------------
# User Code Executor Lambda — sandboxed JS execution (rule conditions, template functions)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "user_code_executor" {
  name = "${var.service_name}-user-code-executor"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "user_code_executor" {
  role = aws_iam_role.user_code_executor.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CloudWatchLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.shared.arn}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "user_code_executor" {
  function_name = "${var.service_name}-user-code"
  role          = aws_iam_role.user_code_executor.arn
  handler       = "user-code-executor.handler"
  runtime       = "nodejs24.x"
  memory_size   = 128
  timeout       = 1
  publish       = true

  filename         = data.archive_file.lambda_stub.output_path
  source_code_hash = data.archive_file.lambda_stub.output_base64sha256

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
# Content Sanitizer Lambda — MIME parsing, HTML sanitization, image proxying
# ---------------------------------------------------------------------------

resource "aws_iam_role" "content_sanitizer" {
  name = "${var.service_name}-content-sanitizer"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "content_sanitizer" {
  role = aws_iam_role.content_sanitizer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CloudWatchLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.shared.arn}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "content_sanitizer" {
  function_name = "${var.service_name}-content-sanitizer"
  role          = aws_iam_role.content_sanitizer.arn
  handler       = "content-sanitizer.handler"
  runtime       = "nodejs24.x"
  memory_size   = 128
  timeout       = 10
  publish       = true

  filename         = data.archive_file.lambda_stub.output_path
  source_code_hash = data.archive_file.lambda_stub.output_base64sha256

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
# Bedrock Model Invocation Logging — captures all Bedrock API calls in region
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "bedrock" {
  name              = "/aws/bedrock/${var.service_name}"
  retention_in_days = 90
}

resource "aws_iam_role" "bedrock_logging" {
  name = "${var.service_name}-bedrock-logging"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
      }
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_logging" {
  role = aws_iam_role.bedrock_logging.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.bedrock.arn}:*"
    }]
  })
}

resource "aws_bedrock_model_invocation_logging_configuration" "main" {
  logging_config {
    embedding_data_delivery_enabled = true
    image_data_delivery_enabled     = false
    text_data_delivery_enabled      = true
    video_data_delivery_enabled     = false

    cloudwatch_config {
      log_group_name = aws_cloudwatch_log_group.bedrock.name
      role_arn       = aws_iam_role.bedrock_logging.arn
    }
  }
}
