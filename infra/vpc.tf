locals {
  azs           = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
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

  tags = { Name = "${local.prefix}-private-${count.index}" }
}

resource "aws_security_group" "aurora" {
  name        = "${local.prefix}-aurora"
  description = "Aurora — no inbound connections needed (accessed via Data API)"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
