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
      domain_validation_options = [
        {
          domain_name           = "email.rhosys.cloud"
          resource_record_name  = "_mock.email.rhosys.cloud."
          resource_record_type  = "CNAME"
          resource_record_value = "_mock.acm-validations.aws."
        },
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
  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/test-svc-spa-rewrite"
    }
  }
  mock_resource "aws_sesv2_configuration_set" {
    defaults = {
      arn = "arn:aws:ses:eu-central-1:123456789012:configuration-set/test-svc-sending"
    }
  }
  mock_resource "aws_sfn_state_machine" {
    defaults = {
      arn = "arn:aws:states:eu-central-1:123456789012:stateMachine:test-svc-mock"
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:eu-central-1:123456789012:test-svc-signals"
      url = "https://sqs.eu-central-1.amazonaws.com/123456789012/test-svc-signals"
    }
  }
  mock_data "aws_kms_secrets" {
    defaults = {
      plaintext = {
        private_key = "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCemhl4SQBbfsaX6qpqPaT2FKGqk1QYkeGQ+o5+GeNDP2Skb905orsv1MEXL9QAGJN0Z/YRsEkW0NRb/V0UjJEJ7dgG/fEsBNzflDMcxxSidZ7bsbgs2IYCoTZ2F/BINKx30QiY0NNAFTAQzfTvHlPuRJAhUXm9q6bMtCkpqDJLpE2KaTechzdh9P+k3b4ET1tXc0bRrKnnlqp4FiH1zIX7kJI8QqRUkQomDtJ+4GoWphVGTaSiTQSltOcQQh5RaINEC+AdpbxOPftWVRIo2o51OKrfq7NuVTAcI+EQeGX6V+Y/+3zJ8QVnZqP4/cw30hbhSj000uFCsQMpL0OA6XsjAgMBAAECggEABsXAyaygWcfXlhwcq823EhT+dEi3QhdUoPq6A/N6C2CVHRpzwWbMBHZaynEt5dUm0sUvskCrVlCTiNwQUfTQqrJf06ibWExa3Cc5aYSswmUwY+Q6X5vdWRZmO3O5PHQXW0RvUAs2whlFhKoux9ktL1L5LpsKjklapYoZ6d/3SdiIh3nOp4Iz2iL12mAhy98bQ7oR3zaDJz8p03k4rKVBIp7Jprn67qH/dUJJOlIFln/uugiw0Sf8kR8nLVW2EHgomNwH70znG2UP0Ym4omi04aDZtw65VUFnxuj6MwnkOLUzp6sphsf9vojfLSlAfG2+v8UsBJzzB4KmvYsaI7rLBQKBgQDSfJJ93UjQEwh3Tzy45JMpabkmQ+ao3cn034xZ77O+N9skCQpQaOZt+ZviGrl1B+eDSIRvEiE9ur4AkyjHuZ2z6qhvbspGVdNE23sqSLQtEkhnCYNtm4aE9dGUEp9K4bPX78pXhOD2y4dB8ZUVnhg7I4Eg1adfriin8x8pUSP0TQKBgQDA5Xdk32lGBnH0HC6z+6f3ToaGV6zQcKMgSrtwrMaELIyPlo16mvGiUyrbHOn+72lWlGlPAghmiUrCCTUE+nnkV3SoIkVme8NhfPOYXqHZPLm2gxnruE1/zmNlpLHiR5NrZ06Jq+156OLW+uIXLy3ho+eXnJmh1GnHo9mzv0KlLwKBgQDP7Uc5FrOq+GJQmfG+I+5L5qiD6GefQRkT0RFwdp30tnDAND4AGOAom38l6Ihz148X3TcWEa7MsACpyLVsNyxWYuRoz+T5fibpynbs2k1CiOEFCBzQ1eYYykxyHcNF0Zg7JCGaOyWQJpZCykcfx8DgCr6wlN52YjC/WCfcRM9jsQKBgQCTCtj2ti+jx6n6MbmQTdf+d4eoxRDhW9ud9BnqjGpPuz3y/wseWRq1aLyUhvgA9DPSYhPcvGn279VjEG2wO9fLLreoq2dH9jQ8DmoKzqiF1vqinFGYFMhPEt9GTkOjgHhqOTfvTnYapmK1Ck5q6fYJuU4Djsa2TBvOqaJ8mOGO1QKBgFWLDmE5AF+4LM6rw1Illcss+/u9o61AGKVSU3oFewAejUNW1lCKT189FDwGns7Rl/23GpVz2V88fk9RwjOeT++0MFIErcgDQMF7Ra2QhkyudM1pnsIOcMzBXmzEt355SqHfaU2UXKhY2EppnOKjh2EcjkeVurlxkwS7nBhCKNP8"
      }
    }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["eu-central-1a", "eu-central-1b", "eu-central-1c"]
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

# Aurora clusters must never be deletable — they hold vector embeddings that are
# expensive to regenerate from raw emails.
run "aurora_cluster_deletion_protection_enabled" {
  command = plan

  assert {
    condition     = alltrue([for k, v in aws_rds_cluster.aurora : v.deletion_protection == true])
    error_message = "All Aurora clusters must have deletion_protection = true"
  }
}

run "aurora_cluster_skips_final_snapshot" {
  command = plan

  assert {
    condition     = alltrue([for k, v in aws_rds_cluster.aurora : v.skip_final_snapshot == true])
    error_message = "All Aurora clusters must skip final snapshot (recovery is via DynamoDB embedding cache + S3 raw emails)"
  }
}
