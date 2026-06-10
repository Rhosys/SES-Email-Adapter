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

# Derive DKIM public key from the private key at plan time.
# Used to publish the TXT record at mail._domainkey.platform.{domain}.
# KMS stores the key as raw base64 DER — wrap in PEM for the tls provider.
data "tls_public_key" "dkim" {
  private_key_pem = "-----BEGIN PRIVATE KEY-----\n${data.aws_kms_secrets.dkim.plaintext["private_key"]}\n-----END PRIVATE KEY-----"
}

locals {
  # Strip PEM headers/footers and newlines to get raw base64 DER for DKIM TXT record.
  dkim_public_key_der = replace(replace(replace(
    data.tls_public_key.dkim.public_key_pem,
    "/-----[A-Z ]+-----/", ""),
    "\n", ""),
  "\r", "")

  # Full DKIM TXT value (prefix + base64 DER public key), before chunking.
  dkim_txt_value = "v=DKIM1; k=rsa; p=${local.dkim_public_key_der}"

  # DNS TXT character-strings are capped at 255 chars (RFC 1035). Split the full
  # value into 255-char windows and rejoin with an escaped "" separator so Route53
  # stores multiple adjacent character-strings in one record; resolvers concatenate
  # them for DKIM verification. regexall yields ceil(len/255) chunks, so this works
  # for any key size (2048 -> 2 strings, 4096 -> 3, etc.). Terraform supplies the
  # outer quotes; only the mid-string "" separator is escaped here.
  dkim_txt_record = join("\"\"", regexall(".{1,255}", local.dkim_txt_value))
}

# ---------------------------------------------------------------------------
# Authress service client — Ed25519 signing key (private key never leaves KMS)
# ---------------------------------------------------------------------------

resource "aws_kms_key" "authress_service_client" {
  description              = "Authress service client Ed25519 signing key"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_EDWARDS25519"
  deletion_window_in_days  = 30
}

resource "aws_kms_alias" "authress_service_client" {
  name          = "alias/${var.service_name}-authress-service-client"
  target_key_id = aws_kms_key.authress_service_client.key_id
}

# Extract the public key — output after apply for Authress registration
data "aws_kms_public_key" "authress_service_client" {
  key_id = aws_kms_key.authress_service_client.key_id
}
