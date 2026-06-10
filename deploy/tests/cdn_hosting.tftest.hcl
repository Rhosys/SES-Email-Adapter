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
  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/test-svc-spa-rewrite"
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

override_data {
  target = data.tls_public_key.dkim
  values = {
    public_key_pem = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----\n"
  }
}

override_resource {
  target = aws_sesv2_email_identity.main
  values = {
    arn = "arn:aws:ses:eu-central-1:123456789012:identity/email.rhosys.cloud"
  }
}

override_resource {
  target = aws_sesv2_email_identity.platform
  values = {
    arn = "arn:aws:ses:eu-central-1:123456789012:identity/platform.email.rhosys.cloud"
  }
}

override_resource {
  target = aws_acm_certificate.api_gateways
  values = {
    arn = "arn:aws:acm:us-east-1:123456789012:certificate/test-cert-gw"
    domain_validation_options = [
      {
        domain_name           = "api.email.rhosys.cloud"
        resource_record_name  = "_mock.api.email.rhosys.cloud."
        resource_record_type  = "CNAME"
        resource_record_value = "_mock.acm-validations.aws."
      },
      {
        domain_name           = "wss.email.rhosys.cloud"
        resource_record_name  = "_mock.wss.email.rhosys.cloud."
        resource_record_type  = "CNAME"
        resource_record_value = "_mock.acm-validations.aws."
      }
    ]
  }
}

override_resource {
  target = aws_acm_certificate.api
  values = {
    arn = "arn:aws:acm:us-east-1:123456789012:certificate/test-cert-api"
    domain_validation_options = [
      {
        domain_name           = "email.rhosys.cloud"
        resource_record_name  = "_mock.email.rhosys.cloud."
        resource_record_type  = "CNAME"
        resource_record_value = "_mock.acm-validations.aws."
      }
    ]
  }
}

override_resource {
  target = aws_sesv2_configuration_set.sending
  values = {
    arn = "arn:aws:ses:eu-central-1:123456789012:configuration-set/test-svc-sending"
  }
}

override_resource {
  target = aws_sfn_state_machine.account_creation
  values = {
    arn = "arn:aws:states:eu-central-1:123456789012:stateMachine:test-svc-AccountCreation"
  }
}

# Site bucket must use account regional namespace — name ends with -an suffix
run "site_bucket_name_uses_account_regional_format" {
  command = plan

  assert {
    condition     = endswith(aws_s3_bucket.web.bucket, "-an")
    error_message = "Site bucket name must end with -an (account-regional namespace)"
  }

  assert {
    condition     = strcontains(aws_s3_bucket.web.bucket, var.aws_account_id)
    error_message = "Site bucket name must contain the AWS account ID"
  }
}

# Site bucket must declare account-regional namespace
run "site_bucket_has_account_regional_namespace" {
  command = plan

  assert {
    condition     = aws_s3_bucket.web.bucket_namespace == "account-regional"
    error_message = "Site bucket must have bucket_namespace = account-regional"
  }
}

# Email bucket must also use account regional namespace
run "email_bucket_name_uses_account_regional_format" {
  command = plan

  assert {
    condition     = endswith(aws_s3_bucket.emails.bucket, "-an")
    error_message = "Email bucket name must end with -an (account-regional namespace)"
  }
}

# Site bucket must block all public access
run "site_bucket_public_access_blocked" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.web.block_public_acls == true
    error_message = "Site bucket must block public ACLs"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.web.block_public_policy == true
    error_message = "Site bucket must block public policy"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.web.ignore_public_acls == true
    error_message = "Site bucket must ignore public ACLs"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.web.restrict_public_buckets == true
    error_message = "Site bucket must restrict public buckets"
  }
}

# OAC must sign all requests with sigv4
run "oac_signing_configuration" {
  command = plan

  assert {
    condition     = aws_cloudfront_origin_access_control.s3.signing_behavior == "always"
    error_message = "OAC signing behavior must be 'always'"
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.s3.signing_protocol == "sigv4"
    error_message = "OAC signing protocol must be 'sigv4'"
  }
}

# CloudFront distribution must have both S3 and API Gateway origins
run "cloudfront_has_multiple_origins" {
  command = plan

  assert {
    condition     = anytrue([for o in aws_cloudfront_distribution.api.origin : o.origin_id == "s3-site"])
    error_message = "CloudFront distribution must have an S3 site origin"
  }

  assert {
    condition     = anytrue([for o in aws_cloudfront_distribution.api.origin : o.origin_id == "api-gateway"])
    error_message = "CloudFront distribution must have an API Gateway origin"
  }
}

# CloudFront Function must exist for SPA rewrite
run "cloudfront_function_exists" {
  command = plan

  assert {
    condition     = aws_cloudfront_function.spa_rewrite.runtime == "cloudfront-js-2.0"
    error_message = "CloudFront Function must exist with cloudfront-js-2.0 runtime"
  }
}
