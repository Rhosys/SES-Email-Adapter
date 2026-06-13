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

  name_prefix = "${lower(var.service_name)}-${each.key}-pg-"
  family      = "aurora-postgresql18"

  # pgvector does not require shared_preload_libraries — it is loaded
  # on-demand via CREATE EXTENSION vector; in the bootstrap migration.

  # -----------------------------------------------------------------------
  # Connection logging
  # Aurora PG17 defaulted both to ON; PG18 changed log_connections from a
  # boolean to an enum (receipt, authentication, authorization,
  # setup_durations, all). Empty string disables it. log_disconnections
  # remains a boolean.
  # -----------------------------------------------------------------------
  parameter {
    name  = "log_connections"
    value = "" # PG18 enum — empty string disables; "all" = log everything
  }
  parameter {
    name  = "log_disconnections"
    value = "0" # boolean — still off/0 in PG18
  }
  parameter {
    name  = "log_hostname"
    value = "0" # OFF — DNS lookup on every connection; irrelevant with Data API
  }

  # -----------------------------------------------------------------------
  # Statement logging
  # -----------------------------------------------------------------------
  parameter {
    name  = "log_statement"
    value = "ddl" # DDL only — captures migrations/schema changes; skips embedding queries
  }
  parameter {
    name  = "log_duration"
    value = "0" # OFF — log_min_duration_statement handles selective slow-query logging
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "5000" # 5 s — log only genuinely slow queries; -1 disables, 0 logs everything
  }

  # -----------------------------------------------------------------------
  # Error / message severity
  # -----------------------------------------------------------------------
  parameter {
    name  = "log_min_messages"
    value = "WARNING" # Aurora default — INFO/DEBUG would be a firehose
  }
  parameter {
    name  = "log_min_error_statement"
    value = "ERROR" # log the SQL text that caused errors and above
  }
  parameter {
    name  = "log_error_verbosity"
    value = "default" # verbose adds stack traces; terse strips useful context
  }

  # -----------------------------------------------------------------------
  # Lock / wait logging
  # -----------------------------------------------------------------------
  parameter {
    name  = "log_lock_waits"
    value = "1" # ON — lock waits are rare but signal contention; worth capturing
  }

  # -----------------------------------------------------------------------
  # Checkpoint logging
  # log_checkpoints does not exist in the aurora-postgresql18 parameter
  # family — Aurora uses a distributed storage layer with no traditional
  # PostgreSQL WAL checkpoints, so the parameter is absent entirely.
  # -----------------------------------------------------------------------

  # -----------------------------------------------------------------------
  # Autovacuum logging
  # -----------------------------------------------------------------------
  parameter {
    name  = "log_autovacuum_min_duration"
    value = "1000" # 1 s — pgvector tables need regular vacuuming; slow runs indicate bloat
  }

  # -----------------------------------------------------------------------
  # Temp file logging
  # -----------------------------------------------------------------------
  parameter {
    name  = "log_temp_files"
    value = "10240" # 10 MB threshold — large spills indicate memory pressure on vector queries
  }

  # -----------------------------------------------------------------------
  # Replication logging
  # -----------------------------------------------------------------------
  parameter {
    name  = "log_replication_commands"
    value = "0" # OFF — single-region, no logical replication in use
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_rds_cluster" "aurora" {
  for_each = local.cluster_registry

  cluster_identifier              = "${lower(var.service_name)}-${each.key}"
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned"
  engine_version                  = "18.3"
  allow_major_version_upgrade     = true
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

# ---------------------------------------------------------------------------
# CloudWatch log group for Aurora PostgreSQL logs
# Aurora auto-creates this log group but with no retention — we adopt it via
# import block and set a 1-year retention policy.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "aurora" {
  for_each = local.cluster_registry

  name              = "/aws/rds/cluster/${lower(var.service_name)}-${each.key}/postgresql"
  retention_in_days = 365
}



# ---------------------------------------------------------------------------
# CodeBuild — migration runner (applies Drizzle migrations via Data API)
# Triggered by CI after deploy. Non-blocking — CI fires and forgets.
# ---------------------------------------------------------------------------

resource "aws_codebuild_project" "migration" {
  name                   = "${lower(var.service_name)}-migrate"
  description            = "Applies Drizzle database migrations to the Aurora cluster via RDS Data API"
  service_role           = aws_iam_role.codebuild_migration.arn
  concurrent_build_limit = 1
  # InvalidInputException: Build badges are not supported for projects with no source
  badge_enabled          = false

  artifacts { type = "NO_ARTIFACTS" }

  source {
    type      = "NO_SOURCE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        build = {
          commands = ["node migrate.js"]
        }
      }
    })
  }

  environment {
    compute_type = "BUILD_GENERAL1_SMALL"
    image        = "aws/codebuild/standard:8.0"
    type         = "LINUX_CONTAINER"

    environment_variable {
      name  = "AURORA_CLUSTER_ARN"
      value = aws_rds_cluster.aurora["aurora-prod-titan-v2"].arn
    }
    environment_variable {
      name  = "AURORA_SECRET_ARN"
      value = aws_rds_cluster.aurora["aurora-prod-titan-v2"].master_user_secret[0].secret_arn
    }
    environment_variable {
      name  = "AURORA_DB_NAME"
      value = "signals"
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.shared.name
      stream_name = "0000/00/00/CodeBuild-${var.service_name}-migration"
    }
  }

  build_timeout = 30
}

resource "aws_iam_role" "codebuild_migration" {
  name = "${var.service_name}-codebuild-migration"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "codebuild_migration" {
  name = "migrate"
  role = aws_iam_role.codebuild_migration.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RdsDataApi"
        Effect   = "Allow"
        Action   = ["rds-data:ExecuteStatement", "rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction", "rds-data:BatchExecuteStatement"]
        Resource = aws_rds_cluster.aurora["aurora-prod-titan-v2"].arn
      },
      {
        Sid      = "SecretsAccess"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_rds_cluster.aurora["aurora-prod-titan-v2"].master_user_secret[0].secret_arn
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.shared.arn}:*"
      },
      {
        Sid      = "S3Source"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetBucketLocation"]
        Resource = [
          "arn:aws:s3:::rhosys-deployments-artifacts-${var.aws_account_id}-${local.primary_region}",
          "arn:aws:s3:::rhosys-deployments-artifacts-${var.aws_account_id}-${local.primary_region}/${lower(var.service_name)}/*"
        ]
      }
    ]
  })
}
