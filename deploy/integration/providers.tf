# Integration-test provider config — used only when running tofu against MiniStack.
#
# CI copies deploy/*.tf to /tmp/itf/ and then overwrites providers.tf with this file.
# The real deploy/providers.tf is never modified.
#
# Usage:
#   mkdir -p /tmp/itf && cp deploy/*.tf /tmp/itf/ && cp deploy/integration/providers.tf /tmp/itf/providers.tf
#   AWS_ACCESS_KEY_ID=ministack-test AWS_SECRET_ACCESS_KEY=ministack-test \
#     tofu -chdir=/tmp/itf apply -backend=false -auto-approve \
#       -var="aws_account_id=000000000000" \
#       -target=aws_dynamodb_table.accounts \
#       -target=aws_dynamodb_table.signals \
#       -target=aws_dynamodb_table.audit

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
  # No backend block — local state only for integration testing.
}

provider "aws" {
  region                      = "eu-central-1"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true
  access_key                  = "ministack-test"
  secret_key                  = "ministack-test"

  endpoints {
    dynamodb       = "http://localhost:4566"
    s3             = "http://localhost:4566"
    sqs            = "http://localhost:4566"
    sns            = "http://localhost:4566"
    kms            = "http://localhost:4566"
    lambda         = "http://localhost:4566"
    sfn            = "http://localhost:4566"
    sts            = "http://localhost:4566"
    iam            = "http://localhost:4566"
    secretsmanager = "http://localhost:4566"
  }

  default_tags {
    tags = {
      App = var.service_name
    }
  }
}

# Alias provider required by cdn.tf and email_routing.tf — skip all validation
# since those resources are never targeted in integration tests.
provider "aws" {
  alias                       = "us_east_1"
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  access_key                  = "ministack-test"
  secret_key                  = "ministack-test"

  default_tags {
    tags = {
      App = var.service_name
    }
  }
}


data "aws_route53_zone" "main" {
  provider = aws.us_east_1
  name     = "email.rhosys.cloud"
}
