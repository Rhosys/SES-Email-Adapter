# Tasks

## Task 1: Migrate email bucket to account regional namespace

- [x] Replace `aws_s3_bucket.emails` in `deploy/storage.tf`:
  - Change `bucket` to `"${var.service_name}-emails-${var.aws_account_id}-eu-west-1-an"`
  - Add `bucket_namespace = "account-regional"`
- [x] Update `aws_s3_bucket_policy.emails` resource reference (bucket ID unchanged since it's the same TF resource)
- [x] Update `AURORA_DB_NAME`, `EMAIL_BUCKET` Lambda env var in `deploy/compute.tf` (references `aws_s3_bucket.emails.bucket`)
- [x] Verify all other references to `aws_s3_bucket.emails` still resolve (lifecycle config, encryption, public access block)

**Requirement:** 5  
**Design ref:** Data Models → S3 Bucket Naming

---

## Task 2: Create site S3 bucket with OAC

- [x] Add to `deploy/cdn.tf`:
  - `aws_s3_bucket.web` with `bucket = "${var.service_name}-web-${var.aws_account_id}-eu-west-1-an"` and `bucket_namespace = "account-regional"`
  - `aws_s3_bucket_public_access_block.web` (all four settings `true`)
  - `aws_s3_bucket_server_side_encryption_configuration.web` (SSE-S3)
  - `aws_s3_bucket_lifecycle_configuration.web` (abort incomplete multipart, 7 days)
  - `aws_cloudfront_origin_access_control.s3` (origin type `s3`, signing behavior `always`, protocol `sigv4`)
  - `aws_s3_bucket_policy.web` granting `s3:GetObject` to `cloudfront.amazonaws.com` conditioned on `aws_cloudfront_distribution.api.arn`

**Requirement:** 1, 2  
**Design ref:** New Resources table

---

## Task 3: Create CloudFront cache policies

- [x] Add `aws_cloudfront_cache_policy.s3_cache` in `deploy/cdn.tf`:
  - Default TTL 86400, max TTL 31536000, min TTL 0
  - Enable gzip + brotli
  - No headers/cookies/query strings forwarded
- [x] Add `aws_cloudfront_cache_policy.assets_cache` in `deploy/cdn.tf`:
  - Default TTL 31536000, max TTL 31536000, min TTL 31536000 (immutable)
  - Enable gzip + brotli
  - No headers/cookies/query strings forwarded
- [x] Add `aws_cloudfront_cache_policy.api_cache` in `deploy/cdn.tf`:
  - Default TTL 0, max TTL 31536000, min TTL 0
  - Forward headers: `Authorization`, `Content-Type`, `Origin`, `Accept`
  - Forward cookies: `authorization`
  - Forward query strings: all
  - Enable gzip + brotli

**Requirement:** 3, 4  
**Design ref:** API Cache Policy code block

---

## Task 4: Create CloudFront Function for SPA rewrite

- [x] Add `aws_cloudfront_function.spa_rewrite` in `deploy/cdn.tf`:
  - Runtime: `cloudfront-js-2.0`
  - Event type: `viewer-request`
  - Code: if URI has no `.` (no file extension), rewrite to `/index.html`
- [x] Function code as a heredoc or file reference in the TF resource

**Requirement:** 3.6  
**Design ref:** CloudFront Function (SPA Rewrite) code block

---

## Task 5: Restructure CloudFront distribution behaviors

- [x] Modify `aws_cloudfront_distribution.api` in `deploy/cdn.tf`:
  - Add S3 origin (`aws_s3_bucket.web.bucket_regional_domain_name`, OAC ID)
  - Change `default_cache_behavior` to target S3 origin with:
    - `aws_cloudfront_cache_policy.s3_cache`
    - Viewer protocol: redirect-to-https
    - Allowed methods: GET, HEAD
    - Cached methods: GET, HEAD
    - Compress: true
    - Function association: `aws_cloudfront_function.spa_rewrite` on `viewer-request`
  - Add ordered cache behavior `/assets/*` targeting S3 origin with:
    - `aws_cloudfront_cache_policy.assets_cache`
    - Viewer protocol: redirect-to-https
    - Allowed methods: GET, HEAD
    - Cached methods: GET, HEAD
    - Compress: true
    - No function association
  - Add ordered cache behavior `/api/*` targeting API Gateway origin with:
    - `aws_cloudfront_cache_policy.api_cache`
    - Viewer protocol: redirect-to-https
    - Allowed methods: all (DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT)
    - Cached methods: GET, HEAD
    - Compress: true
    - No function association
  - Remove `forwarded_values` block from old default behavior (replaced by cache policies)
  - Remove any `custom_error_response` blocks (must not exist — they're distribution-level)

**Requirement:** 3, 4  
**Design ref:** Architecture diagram, CloudFront Behavior Routing table

---

## Task 6: Configure Hono base path

- [x] In `email-catcher/backend/src/api/app.ts`, change:
  ```typescript
  const app = new OpenAPIHono<AppEnv>();
  ```
  to:
  ```typescript
  const app = new OpenAPIHono<AppEnv>({ basePath: '/api' });
  ```
- [x] Update the OpenAPI doc redirect from `/` to `/api/` (or adjust as needed)
- [x] Verify all existing route definitions work unchanged (Hono strips basePath before matching)
- [x] Run `npm run check` to confirm all tests pass

**Requirement:** 4.3  
**Design ref:** API Gateway Path Handling section

---

## Task 7: Update outputs

- [x] Add to `deploy/outputs.tf`:
  - `output "site_bucket_name"` → `aws_s3_bucket.web.bucket`
  - `output "site_bucket_arn"` → `aws_s3_bucket.web.arn`
  - `output "cloudfront_distribution_id"` → `aws_cloudfront_distribution.api.id`
- [x] Update existing email bucket output to reflect new name

**Requirement:** 6  
**Design ref:** Modified Resources table

---

## Task 8: OpenTofu tests

- [x] Create `deploy/tests/cdn_hosting.tftest.hcl`:
  - Assert site bucket name ends with `-an` and contains account ID
  - Assert site bucket has `bucket_namespace = "account-regional"`
  - Assert email bucket name ends with `-an`
  - Assert `aws_s3_bucket_public_access_block.web` has all four settings true
  - Assert OAC signing behavior is `always` and protocol is `sigv4`
  - Assert CloudFront distribution has at least 2 origins
  - Assert CloudFront Function exists
- [x] Include `variables {}` block with test-safe values (`aws_account_id = "123456789012"`, `service_name = "test-svc"`)

**Requirement:** All  
**Design ref:** Testing Strategy section

---

## Task 9: Verify and clean up

- [x] Run `tofu validate` in deploy/ to confirm syntax
- [x] Run `tofu plan` to verify the changeset (expect: create site bucket + OAC + cache policies + CF function, modify distribution + email bucket, destroy old email bucket)
- [x] Run `npm run check` in backend/ to confirm Hono basePath change passes all tests
- [x] Update `email-catcher/backend/TODO.md` to mark the S3 + CloudFront item as complete
