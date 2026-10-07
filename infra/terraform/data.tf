############################ PostgreSQL ############################

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1" # clients must use TLS; the apps verify the certificate (sslmode=verify-full)
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "quizforge"
  username = "quizforge"
  # RDS generates the password and keeps it in Secrets Manager: it never appears in code, plans or CI logs.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period    = 7
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  deletion_protection        = var.deletion_protection
  skip_final_snapshot        = !var.deletion_protection
  final_snapshot_identifier  = var.deletion_protection ? "${local.name}-final" : null
  apply_immediately          = true

  enabled_cloudwatch_logs_exports = ["postgresql"]
}

############################ Queue ############################

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-jobs-dlq"
  message_retention_seconds = 14 * 24 * 3600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${local.name}-jobs"
  visibility_timeout_seconds = 360 # > longest job (5 min budget); the worker heartbeat extends it
  receive_wait_time_seconds  = 20  # long polling
  message_retention_seconds  = 4 * 24 * 3600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3 # keep in sync with the worker's SQS_MAX_RECEIVE
  })
}

data "aws_iam_policy_document" "tls_only" {
  for_each = { jobs = aws_sqs_queue.jobs.arn, dlq = aws_sqs_queue.dlq.arn }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [each.value]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "tls_only" {
  for_each  = { jobs = aws_sqs_queue.jobs.url, dlq = aws_sqs_queue.dlq.url }
  queue_url = each.value
  policy    = data.aws_iam_policy_document.tls_only[each.key].json
}

############################ Secrets ############################
# Containers only: values are set out-of-band (scripts/set-secrets.sh) so they never enter Terraform state.

resource "aws_secretsmanager_secret" "llm" {
  name                    = "${local.name}/llm"
  description             = "MINIMAX_API_KEY"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "langfuse" {
  name                    = "${local.name}/langfuse"
  description             = "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "cognito_web" {
  name                    = "${local.name}/cognito-web-client"
  description             = "Confidential client secret used only by the Next.js BFF"
  recovery_window_in_days = 0
}

# Placeholders only, so tasks can start on the very first deployment. scripts/set-secrets.sh writes the real
# values; ignore_changes stops Terraform from ever reverting them.
resource "aws_secretsmanager_secret_version" "llm_placeholder" {
  secret_id     = aws_secretsmanager_secret.llm.id
  secret_string = jsonencode({ MINIMAX_API_KEY = "not-set-run-scripts-set-secrets" })
  lifecycle { ignore_changes = [secret_string] }
}

resource "aws_secretsmanager_secret_version" "langfuse_placeholder" {
  secret_id     = aws_secretsmanager_secret.langfuse.id
  secret_string = jsonencode({ LANGFUSE_PUBLIC_KEY = "", LANGFUSE_SECRET_KEY = "" })
  lifecycle { ignore_changes = [secret_string] }
}

resource "aws_secretsmanager_secret_version" "cognito_web" {
  secret_id     = aws_secretsmanager_secret.cognito_web.id
  secret_string = jsonencode({ client_secret = aws_cognito_user_pool_client.web.client_secret })
}

# Shared secret between CloudFront and the ALB so the ALB refuses traffic that did not come through CloudFront.
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}
