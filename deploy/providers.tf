terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
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

  backend "s3" {
    # Configure via -backend-config or environment:
    # bucket, key, region
    # use_lockfile = true replaces dynamodb_table for state locking in provider v6+
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region              = "eu-central-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      App = var.service_name
    }
  }
}

# ACM certificates for CloudFront must be provisioned in us-east-1
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      App = var.service_name
    }
  }
}

data "aws_region" "current" {}

data "aws_route53_zone" "main" {
  provider = aws.us_east_1
  name     = "email.rhosys.cloud"
}
