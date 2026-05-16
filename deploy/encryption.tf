# KMS key is owned by the email-catcher/infrastructure repo.
# Look it up by alias — no need to create it here.

data "aws_kms_alias" "default" {
  name = "alias/default"
}

# Decrypt the DKIM private key at plan time.
# The .kms file contains base64-encoded KMS ciphertext, committed to source.
data "aws_kms_secrets" "dkim" {
  secret {
    name    = "private_key"
    payload = file("${path.module}/secrets/dkim-private-key.kms")
  }
}

# ---------------------------------------------------------------------------
# Authress service client — Ed25519 signing key (private key never leaves KMS)
# ---------------------------------------------------------------------------

resource "aws_kms_key" "authress_service_client" {
  description             = "Authress service client Ed25519 signing key"
  key_usage               = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_EDWARDS25519"
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "authress_service_client" {
  name          = "alias/${var.service_name}-authress-service-client"
  target_key_id = aws_kms_key.authress_service_client.key_id
}
