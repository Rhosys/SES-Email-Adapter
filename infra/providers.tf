terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    # Configure via -backend-config or environment:
    # bucket, key, region, dynamodb_table (for state locking)
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      App = var.app_name
      Env = var.env
    }
  }
}

# CloudFront ACM certificates must live in us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

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
