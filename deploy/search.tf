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

  # Aurora PostgreSQL defaults log_connections and log_disconnections to ON.
  # The Data API maintains an internal connection pool, so every Lambda
  # invocation triggers multiple connection/disconnection log entries — the
  # dominant source of log volume. Turn them off; errors are still captured
  # via log_min_messages (WARNING) which remains at its default.
  parameter {
    name  = "log_connections"
    value = "0"
  }

  parameter {
    name  = "log_disconnections"
    value = "0"
  }

  # Log only statements that take longer than 10 seconds. This keeps slow
  # query visibility without logging routine embedding/search queries.
  parameter {
    name  = "log_min_duration_statement"
    value = "10000"
  }
}

resource "aws_rds_cluster" "aurora" {
  for_each = local.cluster_registry

  cluster_identifier              = "${lower(var.service_name)}-${each.key}"
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned"
  engine_version                  = "17.7"
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
