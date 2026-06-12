# ---------------------------------------------------------------------------
# Shared configuration — values used by both production and integration tests.
# This file is NOT overwritten by deploy/integration/providers.tf.
# ---------------------------------------------------------------------------

locals {
  primary_region = "eu-central-1"
}

data "aws_availability_zones" "available" {
  state = "available"
}
