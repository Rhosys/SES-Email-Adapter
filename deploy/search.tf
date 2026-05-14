# ---------------------------------------------------------------------------
# Aurora Serverless v2 (PostgreSQL + pgvector) — multi-cluster via CLUSTER_REGISTRY
# Each entry provisions: cluster, instance, parameter group, security group,
# and bootstrap SQL with composite PK + HNSW index.
# ---------------------------------------------------------------------------

locals {
  # Mirror of src/embedding/cluster-registry.ts CLUSTER_REGISTRY.
  # This is the IaC source of truth for provisioning Aurora resources.
  # The TypeScript registry references the ARNs produced by these resources.
  cluster_registry = {
    "aurora-prod-titan-v2" = {
      model_id   = "amazon.titan-embed-text-v2:0"
      dimensions = 1024
      active     = true
    }
  }
}

# Shared subnet group — all clusters live in the same VPC/subnets
resource "aws_db_subnet_group" "aurora" {
  name       = "${lower(var.service_name)}-aurora"
  subnet_ids = aws_subnet.private[*].id
}

# ---------------------------------------------------------------------------
# Per-cluster resources (keyed by clusterId)
# ---------------------------------------------------------------------------

resource "aws_security_group" "aurora" {
  for_each = local.cluster_registry

  name        = "${lower(var.service_name)}-aurora-${each.key}"
  description = "Aurora ${each.key} - no inbound connections needed (accessed via Data API)"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_rds_cluster_parameter_group" "aurora" {
  for_each = local.cluster_registry

  name   = "${lower(var.service_name)}-${each.key}-pg"
  family = "aurora-postgresql17"

  # pgvector does not require shared_preload_libraries — it is loaded
  # on-demand via CREATE EXTENSION vector; in the bootstrap migration.
}

resource "aws_rds_cluster" "aurora" {
  for_each = local.cluster_registry

  cluster_identifier              = "${lower(var.service_name)}-${each.key}"
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned"
  engine_version                  = "17.4"
  database_name                   = "signals"
  master_username                 = "master_admin"
  manage_master_user_password     = true
  db_subnet_group_name            = aws_db_subnet_group.aurora.name
  vpc_security_group_ids          = [aws_security_group.aurora[each.key].id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora[each.key].name

  serverlessv2_scaling_configuration {
    min_capacity = 0
    max_capacity = 4
  }

  backup_retention_period = 1
  preferred_backup_window = "03:00-04:00"
  deletion_protection     = true
  skip_final_snapshot     = true

  enabled_cloudwatch_logs_exports = ["postgresql"]
  enable_http_endpoint            = true # Aurora Data API

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_rds_cluster_instance" "aurora" {
  for_each = local.cluster_registry

  identifier         = "${lower(var.service_name)}-${each.key}-1"
  cluster_identifier = aws_rds_cluster.aurora[each.key].id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.aurora[each.key].engine
  engine_version     = aws_rds_cluster.aurora[each.key].engine_version
}

# ---------------------------------------------------------------------------
# Per-cluster bootstrap SQL — composite PK schema + HNSW index + RLS
# Triggered once per cluster creation; CI migration script executes the SQL.
# ---------------------------------------------------------------------------

resource "terraform_data" "pgvector_init" {
  for_each = local.cluster_registry

  triggers_replace = [aws_rds_cluster.aurora[each.key].id]

  # Run once after cluster creation via CI migration script (requires VPC access):
  #
  # CREATE EXTENSION IF NOT EXISTS vector;
  #
  # CREATE TABLE arc_embeddings (
  #   arc_id            TEXT NOT NULL,
  #   account_id        TEXT NOT NULL,
  #   recipient_address TEXT NOT NULL,
  #   embedding         vector(${each.value.dimensions}) NOT NULL,
  #   updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  #   PRIMARY KEY (arc_id, account_id, recipient_address)
  # );
  #
  # CREATE INDEX ON arc_embeddings
  #   USING hnsw (embedding vector_cosine_ops);
  #
  # -- Row-Level Security: Lambda must SET LOCAL app.current_account_id before
  # -- any query. If unset, current_setting returns NULL and no rows are visible.
  # ALTER TABLE arc_embeddings ENABLE ROW LEVEL SECURITY;
  # ALTER TABLE arc_embeddings FORCE ROW LEVEL SECURITY;
  # CREATE POLICY arc_tenant_isolation ON arc_embeddings
  #   USING (account_id = current_setting('app.current_account_id', true))
  #   WITH CHECK (account_id = current_setting('app.current_account_id', true));
}
