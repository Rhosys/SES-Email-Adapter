mock_provider "aws" {}
mock_provider "aws" { alias = "us_east_1" }
mock_provider "aws" { alias = "eu_central_1" }

variables {
  aws_account_id = "123456789012"
  service_name   = "test-svc"
}

# Aurora cluster must never be deletable — it holds vector embeddings that are
# expensive to regenerate from raw emails.
run "aurora_cluster_deletion_protection_enabled" {
  command = plan

  assert {
    condition     = aws_rds_cluster.aurora.deletion_protection == true
    error_message = "Aurora cluster must have deletion_protection = true"
  }
}

run "aurora_cluster_retains_final_snapshot" {
  command = plan

  assert {
    condition     = aws_rds_cluster.aurora.skip_final_snapshot == false
    error_message = "Aurora cluster must take a final snapshot on deletion (skip_final_snapshot = false)"
  }
}
