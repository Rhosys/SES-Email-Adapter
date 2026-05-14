locals {
  azs           = ["eu-central-1a", "eu-central-1b", "eu-central-1c"]
  vpc_cidr      = "10.0.0.0/16"
  private_cidrs = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
}

# VPC exists solely to host Aurora — Lambda accesses it via Data API over HTTPS,
# not via a VPC connection, so no NAT gateways, public subnets, or internet
# gateway are needed.

resource "aws_vpc" "main" {
  cidr_block           = local.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = { Name = "${var.service_name}-private-${count.index}" }
}

# Security groups for Aurora clusters are defined in search.tf (per-cluster via for_each)
