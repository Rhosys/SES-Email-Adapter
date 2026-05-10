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
