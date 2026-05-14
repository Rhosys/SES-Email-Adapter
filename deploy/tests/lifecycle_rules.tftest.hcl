mock_provider "aws" {
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:eu-central-1:123456789012:log-group:mock"
    }
  }
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:eu-central-1:123456789012:mock-topic"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-role"
    }
  }
  mock_resource "aws_rds_cluster" {
    defaults = {
      master_user_secret = [{
        secret_arn    = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:mock"
        kms_key_id    = "arn:aws:kms:eu-central-1:123456789012:key/mock-key"
        secret_status = "active"
      }]
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      execution_arn = "arn:aws:execute-api:eu-central-1:123456789012:mockapi"
    }
  }
  mock_resource "aws_lambda_alias" {
    defaults = {
      arn        = "arn:aws:lambda:eu-central-1:123456789012:function:mock:production"
      invoke_arn = "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-central-1:123456789012:function:mock:production/invocations"
    }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = {
      arn = "arn:aws:events:eu-central-1:123456789012:rule/mock-rule"
    }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/mock"
    }
  }
  mock_data "aws_kms_secrets" {
    defaults = {
      plaintext = {
        private_key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xfn/ygWep4PAtGoRBh0o"
      }
    }
  }
  mock_data "aws_kms_alias" {
    defaults = {
      target_key_arn = "arn:aws:kms:eu-central-1:123456789012:key/mock-key"
    }
  }
}
mock_provider "aws" {
  alias = "us_east_1"
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/mock"
    }
  }
}

variables {
  aws_account_id = "123456789012"
  service_name   = "test-svc"
}

# Verify exactly 2 lifecycle rules exist on the emails bucket
run "lifecycle_rules_count" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.emails.rule) == 2
    error_message = "Email bucket must have exactly 2 lifecycle rules"
  }
}

# Rule 1: inbox/ prefix + tag retention-tier=P1Y → expire after 365 days
run "lifecycle_rule_free_tier" {
  command = plan

  assert {
    condition     = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.emails.rule :
      rule.id == "inbox-free-tier-1yr" &&
      rule.status == "Enabled" &&
      rule.filter[0].and[0].prefix == "inbox/" &&
      rule.filter[0].and[0].tags["retention-tier"] == "P1Y" &&
      rule.expiration[0].days == 365
    ])
    error_message = "Free-tier rule must have id='inbox-free-tier-1yr', prefix='inbox/', tag retention-tier=P1Y, expiration=365 days"
  }
}

# Rule 2: inbox/ prefix (no tag filter) → expire after 1825 days
run "lifecycle_rule_paid_default" {
  command = plan

  assert {
    condition     = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.emails.rule :
      rule.id == "inbox-default-5yr" &&
      rule.status == "Enabled" &&
      rule.filter[0].prefix == "inbox/" &&
      rule.expiration[0].days == 1825
    ])
    error_message = "Paid default rule must have id='inbox-default-5yr', prefix='inbox/', no tag filter, expiration=1825 days"
  }
}

# No rule covers saved/ prefix
run "lifecycle_rule_no_saved_prefix" {
  command = plan

  assert {
    condition     = alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.emails.rule :
      !anytrue([
        for filter in rule.filter :
        filter.prefix == "saved/" ||
        (filter.and != null && anytrue([for t in filter.and : t.prefix == "saved/"]))
      ])
    ])
    error_message = "No lifecycle rule must cover the saved/ prefix"
  }
}
