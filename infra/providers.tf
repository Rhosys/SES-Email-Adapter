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
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      App = var.app_name
      Env = var.env
    }
  }
}

# CloudFront ACM certificates must live in us-east-1
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      App = var.app_name
      Env = var.env
    }
  }
}

locals {
  prefix = "${var.app_name}-${var.env}"
}
