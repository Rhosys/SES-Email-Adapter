mock_provider "aws" {}
mock_provider "aws" { alias = "us_east_1" }

variables {
  aws_account_id = "123456789012"
  service_name   = "test-svc"
}

# Aurora clusters must never be deletable — they hold vector embeddings that are
# expensive to regenerate from raw emails.
run "aurora_cluster_deletion_protection_enabled" {
  command = plan

  assert {
    condition     = alltrue([for k, v in aws_rds_cluster.aurora : v.deletion_protection == true])
    error_message = "All Aurora clusters must have deletion_protection = true"
  }
}

run "aurora_cluster_skips_final_snapshot" {
  command = plan

  assert {
    condition     = alltrue([for k, v in aws_rds_cluster.aurora : v.skip_final_snapshot == true])
    error_message = "All Aurora clusters must skip final snapshot (recovery is via DynamoDB embedding cache + S3 raw emails)"
  }
}
