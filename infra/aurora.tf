# ---------------------------------------------------------------------------
# Aurora Serverless v2 (PostgreSQL + pgvector)
# Used exclusively for vector embeddings (Arc matching + semantic search)
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "aurora" {
  name       = "${local.prefix}-aurora"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_rds_cluster_parameter_group" "aurora" {
  name   = "${local.prefix}-aurora-pg"
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
  name                    = "${local.prefix}/aurora/master"
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
  cluster_identifier          = "${local.prefix}-aurora"
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned"
  engine_version              = "16.4"
  database_name               = "signals"
  master_username             = "admin"
  manage_master_user_password = false
  master_password             = random_password.aurora_master.result
  db_subnet_group_name        = aws_db_subnet_group.aurora.name
  vpc_security_group_ids      = [aws_security_group.aurora.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora.name

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 4
  }

  backup_retention_period   = 7
  preferred_backup_window   = "03:00-04:00"
  deletion_protection       = var.env == "prod"
  skip_final_snapshot       = var.env != "prod"
  final_snapshot_identifier = var.env == "prod" ? "${local.prefix}-final" : null

  enabled_cloudwatch_logs_exports = ["postgresql"]
}

resource "aws_rds_cluster_instance" "aurora" {
  identifier         = "${local.prefix}-aurora-1"
  cluster_identifier = aws_rds_cluster.aurora.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version
}

# ---------------------------------------------------------------------------
# RDS Proxy
# Pools Lambda connections to avoid exhausting Aurora's connection limit
# ---------------------------------------------------------------------------

resource "aws_iam_role" "rds_proxy" {
  name = "${local.prefix}-rds-proxy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "rds_proxy_secrets" {
  role = aws_iam_role.rds_proxy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = aws_secretsmanager_secret.aurora_master.arn
    }]
  })
}

resource "aws_db_proxy" "aurora" {
  name                   = "${local.prefix}-proxy"
  debug_logging          = false
  engine_family          = "POSTGRESQL"
  idle_client_timeout    = 1800
  require_tls            = true
  role_arn               = aws_iam_role.rds_proxy.arn
  vpc_security_group_ids = [aws_security_group.rds_proxy.id]
  vpc_subnet_ids         = aws_subnet.private[*].id

  auth {
    auth_scheme = "SECRETS"
    secret_arn  = aws_secretsmanager_secret.aurora_master.arn
    iam_auth    = "REQUIRED"
  }
}

resource "aws_db_proxy_default_target_group" "aurora" {
  db_proxy_name = aws_db_proxy.aurora.name

  connection_pool_config {
    max_connections_percent      = 90
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "aurora" {
  db_proxy_name          = aws_db_proxy.aurora.name
  target_group_name      = aws_db_proxy_default_target_group.aurora.name
  db_cluster_identifier  = aws_rds_cluster.aurora.cluster_identifier
}

resource "terraform_data" "pgvector_init" {
  triggers_replace = [aws_rds_cluster.aurora.id]

  # Run after cluster is available to enable the pgvector extension
  # In practice this is handled by a migration script in your CI pipeline:
  #   psql $DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS vector;"
  #   psql $DATABASE_URL -c "CREATE TABLE arc_embeddings (arc_id TEXT PRIMARY KEY, embedding vector(1024));"
  #   psql $DATABASE_URL -c "CREATE INDEX ON arc_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);"
}
