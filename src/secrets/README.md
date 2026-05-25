# Secrets

KMS-encrypted secrets bundled with the repo. Decrypted by CI and passed as Lambda env vars.

## calendar-hmac.kms

32-byte random HMAC secret for calendar proxy UID validation.

**Generate:**
```bash
cd /home/warren/git/claude/_tools
npx tsx src/kms-encrypt.ts --key-alias alias/default --origin "$(git -C /home/warren/git/claude/email-catcher/backend remote get-url origin)" --string "$(head -c 32 /dev/urandom | base64 -w0)" > /home/warren/git/claude/email-catcher/backend/src/secrets/calendar-hmac.kms
```

Requires `kms:Encrypt` on the email-catcher infrastructure KMS key (`alias/default` in account 342695602194). The `--origin` flag passes the email-catcher git remote so the tool authenticates against the correct AWS account.

**CI decryption** (in `.gitlab-ci.yml` or Terraform):
```bash
CALENDAR_HMAC_SECRET=$(aws kms decrypt \
  --ciphertext-blob fileb://src/secrets/calendar-hmac.kms \
  --output text --query Plaintext)
```

The Lambda receives `CALENDAR_HMAC_SECRET` as a base64-encoded env var.
