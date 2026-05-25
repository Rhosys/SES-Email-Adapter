# Secrets

KMS-encrypted secrets bundled with the repo. Decrypted by CI and passed as Lambda env vars.

## calendar-hmac.kms

32-byte random HMAC secret for calendar proxy UID validation.

**Generate:**
```bash
head -c 32 /dev/urandom | base64 -w0 > /tmp/hmac-plaintext.b64
cd /home/warren/git/claude/_tools
npx tsx src/kms-encrypt.ts --key-alias alias/default --string "$(cat /tmp/hmac-plaintext.b64)" > /home/warren/git/claude/email-catcher/backend/src/secrets/calendar-hmac.kms
rm /tmp/hmac-plaintext.b64
```

Requires `kms:Encrypt` on the email-catcher infrastructure KMS key (`alias/default` in account REDACTED).

**CI decryption** (in `.gitlab-ci.yml` or Terraform):
```bash
CALENDAR_HMAC_SECRET=$(aws kms decrypt \
  --ciphertext-blob fileb://src/secrets/calendar-hmac.kms \
  --output text --query Plaintext)
```

The Lambda receives `CALENDAR_HMAC_SECRET` as a base64-encoded env var.
