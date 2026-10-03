# ---------------------------------------------------------------------------
# Shared configuration — values used by both production and integration tests.
# The integration transformer (tests-integration/infrastructure/) regenerates
# providers but leaves this file intact.
# ---------------------------------------------------------------------------

locals {
  primary_region = "eu-central-1"
}

data "aws_availability_zones" "available" {
  state = "available"
}
