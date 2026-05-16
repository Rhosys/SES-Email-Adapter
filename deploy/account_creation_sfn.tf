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
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = "${aws_lambda_function.main.arn}:production"
    }]
  })
}

# ---------------------------------------------------------------------------
# State machine definition
# ---------------------------------------------------------------------------

resource "aws_sfn_state_machine" "account_creation" {
  name     = "email-catcher-AccountCreation"
  role_arn = aws_iam_role.account_creation_sfn.arn
  type     = "STANDARD"

  definition = jsonencode({
    StartAt = "InitialWait"
    States = {
      InitialWait = {
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
          IntervalSeconds = 60
          MaxAttempts     = 5
          BackoffRate     = 2
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
          IntervalSeconds = 60
          MaxAttempts     = 5
          BackoffRate     = 2
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
          IntervalSeconds = 60
          MaxAttempts     = 5
          BackoffRate     = 2
        }]
      }
      IsStillTrial = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.trialCheckResult.accountIsTrial"
          BooleanEquals = true
          Next          = "TrialCheckWait"
        }]
        Default = "Done"
      }
      Done = {
        Type = "Succeed"
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
