# ---------------------------------------------------------------------------
# Aurora Serverless v2 (PostgreSQL + pgvector)
# Used exclusively for vector embeddings (Arc matching + semantic search)
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "aurora" {
  name       = "${lower(var.service_name)}-aurora"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_rds_cluster_parameter_group" "aurora" {
  name   = "${lower(var.service_name)}-aurora-pg"
  family = "aurora-postgresql16"

  parameter {
    name  = "shared_preload_libraries"
    value = "pgvector"
  }
}

resource "random_password" "aurora_master" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "aurora_master" {
  name                    = "${var.service_name}/aurora/master"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "aurora_master" {
  secret_id = aws_secretsmanager_secret.aurora_master.id
  secret_string = jsonencode({
    username = "admin"
    password = random_password.aurora_master.result
  })
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier              = "${var.service_name}-aurora"
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned"
  engine_version                  = "16.4"
  database_name                   = "signals"
  master_username                 = "admin"
  manage_master_user_password     = false
  master_password                 = random_password.aurora_master.result
  db_subnet_group_name            = aws_db_subnet_group.aurora.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora.name

  serverlessv2_scaling_configuration {
    min_capacity = 0
    max_capacity = 4
  }

  backup_retention_period   = 7
  preferred_backup_window   = "03:00-04:00"
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.service_name}-aurora-final"

  enabled_cloudwatch_logs_exports = ["postgresql"]
  enable_http_endpoint            = true # Aurora Data API
}

resource "aws_rds_cluster_instance" "aurora" {
  identifier         = "${var.service_name}-aurora-1"
  cluster_identifier = aws_rds_cluster.aurora.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version
}


resource "terraform_data" "pgvector_init" {
  triggers_replace = [aws_rds_cluster.aurora.id]

  # Run once after cluster creation via CI migration script (requires VPC access):
  #
  # CREATE EXTENSION IF NOT EXISTS vector;
  #
  # CREATE TABLE arc_embeddings (
  #   arc_id           TEXT PRIMARY KEY,
  #   account_id       TEXT NOT NULL,
  #   recipient_address TEXT NOT NULL,
  #   embedding        vector(1024) NOT NULL,
  #   updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
