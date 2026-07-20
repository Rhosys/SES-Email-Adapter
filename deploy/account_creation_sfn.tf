# ── Step Function — Account Creation onboarding workflow ──────────────────────
# Orchestrates follow-up emails and trial status checks over several weeks
# after a new account is created via POST /accounts.

# ---------------------------------------------------------------------------
# IAM role for the state machine
# ---------------------------------------------------------------------------

resource "aws_iam_role" "account_creation_sfn" {
  name = "email-catcher-AccountCreation-sfn"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "account_creation_sfn_invoke_lambda" {
  role = aws_iam_role.account_creation_sfn.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = "${aws_lambda_function.main.arn}:production"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups",
        ]
        Resource = "*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch log group — captures failed executions for diagnosis
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "account_creation_sfn" {
  name              = "/aws/states/email-catcher-AccountCreation"
  retention_in_days = 30
}

# ---------------------------------------------------------------------------
# State machine definition
#
# IMPORTANT — updating this definition does NOT affect executions already in
# flight: AWS Step Functions freezes the definition an execution started
# with, so an account whose execution is already past a given Wait state when
# you deploy a change will never see a state you inserted earlier in the
# chain. When moving logic from one step to another (as SetupDefaults did,
# splitting work out of FirstFollowup), decide explicitly whether in-flight
# executions at deploy time are allowed to miss that logic, or whether it
# needs to stay duplicated somewhere they'll still reach until they drain.
# ---------------------------------------------------------------------------

resource "aws_sfn_state_machine" "account_creation" {
  name     = "email-catcher-AccountCreation"
  role_arn = aws_iam_role.account_creation_sfn.arn
  type     = "STANDARD"

  logging_configuration {
    level                  = "ERROR"
    include_execution_data = true
    log_destination        = "${aws_cloudwatch_log_group.account_creation_sfn.arn}:*"
  }

  definition = jsonencode({
    StartAt = "InitialWait"
    States = {
      # A short wait before SetupDefaults runs, not an instant Task at
      # execution start — gives other first-level account-creation work
      # (domain/alias provisioning etc. kicked off around the same time)
      # a chance to settle first, rather than racing it.
      InitialWait = {
        Type    = "Wait"
        Seconds = 3600
        Next    = "SetupDefaults"
      }
      # So a new account has a working digest/calendar forwarding target
      # within its first hour rather than waiting the full 7 days for
      # FirstFollowup. Best-effort: a failure here falls through to
      # FirstFollowupWait rather than TaskFailed, so it never blocks the
      # rest of onboarding (followup email, cleanup, trial check). No
      # safety-net retry elsewhere in this chain — see the definition-freeze
      # note above: accounts already in flight when this state was
      # introduced simply won't get a default set.
      SetupDefaults = {
        Type     = "Task"
        Resource = "${aws_lambda_function.main.arn}:production"
        Parameters = {
          "context.$" = "$$"
        }
        ResultPath = "$.setupDefaultsResult"
        Next       = "FirstFollowupWait"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          MaxAttempts     = 3
          BackoffRate     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "FirstFollowupWait"
          ResultPath  = "$.setupDefaultsError"
        }]
      }
      # The original 7-day wait before the first followup nudge email —
      # unchanged duration, just no longer the very first state.
      FirstFollowupWait = {
        Type    = "Wait"
        Seconds = 604800
        Next    = "FirstFollowup"
      }
      FirstFollowup = {
        Type     = "Task"
        Resource = "${aws_lambda_function.main.arn}:production"
        Parameters = {
          "context.$" = "$$"
        }
        ResultPath = "$.firstFollowupResult"
        Next       = "SecondWait"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          MaxAttempts     = 18
          BackoffRate     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "TaskFailed"
          ResultPath  = "$.error"
        }]
      }
      SecondWait = {
        Type    = "Wait"
        Seconds = 604800
        Next    = "Cleanup"
      }
      Cleanup = {
        Type     = "Task"
        Resource = "${aws_lambda_function.main.arn}:production"
        Parameters = {
          "context.$" = "$$"
        }
        ResultPath = "$.cleanupResult"
        Next       = "TrialCheckWait"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          MaxAttempts     = 18
          BackoffRate     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "TaskFailed"
          ResultPath  = "$.error"
        }]
      }
      TrialCheckWait = {
        Type    = "Wait"
        Seconds = 604800
        Next    = "TrialCheck"
      }
      TrialCheck = {
        Type     = "Task"
        Resource = "${aws_lambda_function.main.arn}:production"
        Parameters = {
          "context.$" = "$$"
        }
        ResultPath = "$.trialCheckResult"
        Next       = "IsStillTrial"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          MaxAttempts     = 18
          BackoffRate     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "TaskFailed"
          ResultPath  = "$.error"
        }]
      }
      IsStillTrial = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.trialCheckResult.accountIsTrial", BooleanEquals = true },
            { Variable = "$.trialCheckResult.trialExpired", BooleanEquals = false },
          ]
          Next = "TrialCheckWait"
        }]
        Default = "Done"
      }
      Done = {
        Type = "Succeed"
      }
      TaskFailed = {
        Type  = "Fail"
        Error = "TaskFailed"
        Cause = "Onboarding task failed after all retries — check CloudWatch Logs for details"
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Lambda permission — allow the state machine to invoke the production alias
# ---------------------------------------------------------------------------

resource "aws_lambda_permission" "sfn_invoke_backend" {
  statement_id  = "AllowAccountCreationSFNInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.main.function_name
  qualifier     = "production"
  principal     = "states.amazonaws.com"
  source_arn    = aws_sfn_state_machine.account_creation.arn
}
