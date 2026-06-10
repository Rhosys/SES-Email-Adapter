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
  mock_data "aws_kms_secrets" {
    defaults = {
      plaintext = {
        private_key = "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCemhl4SQBbfsaX6qpqPaT2FKGqk1QYkeGQ+o5+GeNDP2Skb905orsv1MEXL9QAGJN0Z/YRsEkW0NRb/V0UjJEJ7dgG/fEsBNzflDMcxxSidZ7bsbgs2IYCoTZ2F/BINKx30QiY0NNAFTAQzfTvHlPuRJAhUXm9q6bMtCkpqDJLpE2KaTechzdh9P+k3b4ET1tXc0bRrKnnlqp4FiH1zIX7kJI8QqRUkQomDtJ+4GoWphVGTaSiTQSltOcQQh5RaINEC+AdpbxOPftWVRIo2o51OKrfq7NuVTAcI+EQeGX6V+Y/+3zJ8QVnZqP4/cw30hbhSj000uFCsQMpL0OA6XsjAgMBAAECggEABsXAyaygWcfXlhwcq823EhT+dEi3QhdUoPq6A/N6C2CVHRpzwWbMBHZaynEt5dUm0sUvskCrVlCTiNwQUfTQqrJf06ibWExa3Cc5aYSswmUwY+Q6X5vdWRZmO3O5PHQXW0RvUAs2whlFhKoux9ktL1L5LpsKjklapYoZ6d/3SdiIh3nOp4Iz2iL12mAhy98bQ7oR3zaDJz8p03k4rKVBIp7Jprn67qH/dUJJOlIFln/uugiw0Sf8kR8nLVW2EHgomNwH70znG2UP0Ym4omi04aDZtw65VUFnxuj6MwnkOLUzp6sphsf9vojfLSlAfG2+v8UsBJzzB4KmvYsaI7rLBQKBgQDSfJJ93UjQEwh3Tzy45JMpabkmQ+ao3cn034xZ77O+N9skCQpQaOZt+ZviGrl1B+eDSIRvEiE9ur4AkyjHuZ2z6qhvbspGVdNE23sqSLQtEkhnCYNtm4aE9dGUEp9K4bPX78pXhOD2y4dB8ZUVnhg7I4Eg1adfriin8x8pUSP0TQKBgQDA5Xdk32lGBnH0HC6z+6f3ToaGV6zQcKMgSrtwrMaELIyPlo16mvGiUyrbHOn+72lWlGlPAghmiUrCCTUE+nnkV3SoIkVme8NhfPOYXqHZPLm2gxnruE1/zmNlpLHiR5NrZ06Jq+156OLW+uIXLy3ho+eXnJmh1GnHo9mzv0KlLwKBgQDP7Uc5FrOq+GJQmfG+I+5L5qiD6GefQRkT0RFwdp30tnDAND4AGOAom38l6Ihz148X3TcWEa7MsACpyLVsNyxWYuRoz+T5fibpynbs2k1CiOEFCBzQ1eYYykxyHcNF0Zg7JCGaOyWQJpZCykcfx8DgCr6wlN52YjC/WCfcRM9jsQKBgQCTCtj2ti+jx6n6MbmQTdf+d4eoxRDhW9ud9BnqjGpPuz3y/wseWRq1aLyUhvgA9DPSYhPcvGn279VjEG2wO9fLLreoq2dH9jQ8DmoKzqiF1vqinFGYFMhPEt9GTkOjgHhqOTfvTnYapmK1Ck5q6fYJuU4Djsa2TBvOqaJ8mOGO1QKBgFWLDmE5AF+4LM6rw1Illcss+/u9o61AGKVSU3oFewAejUNW1lCKT189FDwGns7Rl/23GpVz2V88fk9RwjOeT++0MFIErcgDQMF7Ra2QhkyudM1pnsIOcMzBXmzEt355SqHfaU2UXKhY2EppnOKjh2EcjkeVurlxkwS7nBhCKNP8"
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

# Use real TLS public key derived from the test private key above.
# This tests the PEM-stripping regex in locals.dkim_public_key_der.
override_data {
  target = data.tls_public_key.dkim
  values = {
    public_key_pem = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnpoZeEkAW37Gl+qqaj2k\n9hShqpNUGJHhkPqOfhnjQz9kpG/dOaK7L9TBFy/UABiTdGf2EbBJFtDUW/1dFIyR\nCe3YBv3xLATc35QzHMcUonWe27G4LNiGAqE2dhfwSDSsd9EImNDTQBUwEM307x5T\n7kSQIVF5vaumzLQpKagyS6RNimk3nIc3YfT/pN2+BE9bV3NG0ayp55aqeBYh9cyF\n+5CSPEKkVJEKJg7SfuBqFqYVRk2kok0EpbTnEEIeUWiDRAvgHaW8Tj37VlUSKNqO\ndTiq36uzblUwHCPhEHhl+lfmP/t8yfEFZ2aj+P3MN9IW4Uo9NNLhQrEDKS9DgOl7\nIwIDAQAB\n-----END PUBLIC KEY-----\n"
  }
}

# DKIM record for platform subdomain must be TXT with public key
run "platform_dkim_record_is_txt" {
  command = plan

  assert {
    condition     = aws_route53_record.ses_dkim.type == "TXT"
    error_message = "Platform DKIM record must be TXT, not CNAME"
  }

  assert {
    condition     = anytrue([for r in aws_route53_record.ses_dkim.records : startswith(r, "v=DKIM1; k=rsa; p=")])
    error_message = "Platform DKIM TXT record must contain DKIM version, key type, and public key"
  }

  assert {
    condition     = strcontains(aws_route53_record.ses_dkim.name, "mail._domainkey.platform.")
    error_message = "Platform DKIM record must be at mail._domainkey.platform.{domain}"
  }
}

# DKIM record for root domain must be TXT with public key
run "root_dkim_record_is_txt" {
  command = plan

  assert {
    condition     = aws_route53_record.ses_dkim_root.type == "TXT"
    error_message = "Root DKIM record must be TXT, not CNAME"
  }

  assert {
    condition     = anytrue([for r in aws_route53_record.ses_dkim_root.records : startswith(r, "v=DKIM1; k=rsa; p=")])
    error_message = "Root DKIM TXT record must contain DKIM version, key type, and public key"
  }
}

# DKIM TXT values must not contain PEM headers
run "dkim_txt_no_pem_headers" {
  command = plan

  assert {
    condition     = alltrue([for r in aws_route53_record.ses_dkim.records : !strcontains(r, "-----")])
    error_message = "DKIM TXT record must not contain PEM header/footer markers"
  }
}

# Root identity must have Custom MAIL FROM configured
run "root_identity_has_mail_from" {
  command = plan

  assert {
    condition     = aws_sesv2_email_identity_mail_from_attributes.root.mail_from_domain == "bounce.email.rhosys.cloud"
    error_message = "Root identity must have Custom MAIL FROM at bounce.email.rhosys.cloud"
  }
}

# Bounce subdomain for root must have MX record
run "root_bounce_has_mx" {
  command = plan

  assert {
    condition     = aws_route53_record.bounce_mx_root.type == "MX"
    error_message = "Root bounce subdomain must have an MX record"
  }

  assert {
    condition     = anytrue([for r in aws_route53_record.bounce_mx_root.records : strcontains(r, "feedback-smtp.")])
    error_message = "Root bounce MX must point to SES feedback-smtp endpoint"
  }
}

# Bounce subdomain for root must have SPF record
run "root_bounce_has_spf" {
  command = plan

  assert {
    condition     = aws_route53_record.bounce_spf_root.type == "TXT"
    error_message = "Root bounce subdomain must have a TXT/SPF record"
  }

  assert {
    condition     = anytrue([for r in aws_route53_record.bounce_spf_root.records : strcontains(r, "include:amazonses.com")])
    error_message = "Root bounce SPF must include amazonses.com"
  }
}
