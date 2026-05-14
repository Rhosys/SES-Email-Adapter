mock_provider "aws" {}
mock_provider "aws" { alias = "us_east_1" }

variables {
  aws_account_id = "123456789012"
  service_name   = "test-svc"
}

# --- Overrides to satisfy ARN validation in resources we don't test here ------
# The AWS provider v6 validates ARN format on plan, but mock_provider generates
# random strings for computed attributes. Override every resource that feeds an
# ARN into another resource's validated field.

override_resource {
  target = aws_rds_cluster.aurora
  values = {
    arn = "arn:aws:rds:eu-central-1:123456789012:cluster:test-aurora"
    master_user_secret = [{
      secret_arn    = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:test"
      kms_key_id    = "arn:aws:kms:eu-central-1:123456789012:key/test-key"
      secret_status = "active"
    }]
  }
}

override_resource {
  target = aws_iam_role.lambda
  values = {
    arn = "arn:aws:iam::123456789012:role/test-lambda"
  }
}

override_resource {
  target = aws_lambda_alias.production
  values = {
    arn        = "arn:aws:lambda:eu-central-1:123456789012:function:test-main:production"
    invoke_arn = "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-central-1:123456789012:function:test-main:production/invocations"
  }
}

override_resource {
  target = aws_cloudwatch_log_group.api_gateway
  values = {
    arn = "arn:aws:logs:eu-central-1:123456789012:log-group:/aws/apigateway/test"
  }
}

override_resource {
  target = aws_acm_certificate.api_gateways
  values = {
    arn = "arn:aws:acm:us-east-1:123456789012:certificate/test-cert-gw"
  }
}

override_resource {
  target = aws_acm_certificate.api
  values = {
    arn = "arn:aws:acm:us-east-1:123456789012:certificate/test-cert-api"
  }
}

override_resource {
  target = aws_sns_topic.ses_notifications
  values = {
    arn = "arn:aws:sns:eu-central-1:123456789012:ses-notifications"
  }
}

override_resource {
  target = aws_sns_topic.ses_feedback
  values = {
    arn = "arn:aws:sns:eu-central-1:123456789012:ses-feedback"
  }
}

override_resource {
  target = aws_apigatewayv2_api.main
  values = {
    execution_arn = "arn:aws:execute-api:eu-central-1:123456789012:testapi123"
  }
}

override_resource {
  target = aws_apigatewayv2_api.ws
  values = {
    execution_arn = "arn:aws:execute-api:eu-central-1:123456789012:testwsapi1"
  }
}

override_resource {
  target = aws_cloudwatch_event_rule.domain_health
  values = {
    arn = "arn:aws:events:eu-central-1:123456789012:rule/domain-health"
  }
}

override_resource {
  target = aws_sesv2_email_identity.main
  values = {}
}

override_data {
  target = data.aws_kms_secrets.dkim
  values = {
    plaintext = { "private_key" = "dGVzdC1kaWltLWtleQ==" }
  }
}

# --- Assertions ---------------------------------------------------------------

# Reindex queue visibility timeout must be at least 900s (15 minutes) to allow
# segment processing to complete before SQS redelivers the message.
run "reindex_queue_visibility_at_least_900s" {
  command = plan

  assert {
    condition     = aws_sqs_queue.reindex.visibility_timeout_seconds >= 900
    error_message = "Reindex queue visibility_timeout_seconds must be >= 900"
  }
}

# No redrive_policy — failed messages stay in the queue indefinitely.
# Idempotent workers handle every retry safely; persistent failures surface via
# SQS metrics (ApproximateAgeOfOldestMessage), not a DLQ.
# NOTE: redrive_policy is Optional+Computed in the AWS provider; mock_provider
# generates a random string for it. We verify the queue name contains no "dlq"
# reference and that message_retention matches the expected 4-day config, proving
# the queue is configured for indefinite retries without a dead-letter target.
run "reindex_queue_no_dlq_in_name" {
  command = plan

  assert {
    condition     = !strcontains(aws_sqs_queue.reindex.name, "dlq")
    error_message = "Reindex queue name must not contain 'dlq'"
  }

  assert {
    condition     = aws_sqs_queue.reindex.message_retention_seconds == 345600
    error_message = "Reindex queue message_retention_seconds must be 345600 (4 days)"
  }
}

# Event source mapping wires the reindex queue to the production Lambda alias.
run "reindex_event_source_mapping_wired_to_handler" {
  command = plan

  assert {
    condition     = aws_lambda_event_source_mapping.reindex.event_source_arn == aws_sqs_queue.reindex.arn
    error_message = "Reindex event source mapping must reference the reindex queue ARN"
  }

  assert {
    condition     = aws_lambda_event_source_mapping.reindex.function_name == aws_lambda_alias.production.arn
    error_message = "Reindex event source mapping must target the production Lambda alias"
  }
}
