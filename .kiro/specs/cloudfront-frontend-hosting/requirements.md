# Requirements Document

## Introduction

Add an S3-backed static site origin to the existing CloudFront distribution so the front-end application (email-catcher/site) can deploy HTML, JS, and CSS assets to S3 and serve them via CloudFront at the apex domain. The API continues to be served from the same distribution under a path-based behavior (`/api/*`), while the default behavior serves static assets from S3.

All S3 buckets in the project are migrated to the AWS account regional namespace format (`{prefix}-{account_id}-{region}-an`). Since there is no existing email data, old buckets are simply replaced (no migration needed).

## Glossary

- **Distribution**: The existing CloudFront distribution (`aws_cloudfront_distribution.api`) that currently fronts the API Gateway origin
- **Site_Bucket**: The new S3 bucket that stores static front-end assets (HTML, JS, CSS, images)
- **OAC**: Origin Access Control — the AWS-recommended mechanism for granting CloudFront read access to a private S3 bucket (replaces the deprecated OAI)
- **Account_Regional_Format**: The AWS S3 account regional namespace bucket naming convention `{prefix}-{account_id}-{region}-an` where `-an` is the fixed suffix indicating account-regional namespace. Requires `bucket_namespace = "account-regional"` on the resource.
- **Site_Origin**: The CloudFront origin pointing to the Site_Bucket via OAC
- **API_Origin**: The existing CloudFront origin pointing to the API Gateway custom domain

## Requirements

### Requirement 1: Static Asset S3 Bucket

**User Story:** As a front-end developer, I want a dedicated S3 bucket for static site assets, so that the site repo can deploy built files to a known location.

#### Acceptance Criteria

1. THE Site_Bucket SHALL use the Account_Regional_Format naming convention (`${var.service_name}-web-${var.aws_account_id}-eu-west-1-an`)
2. THE Site_Bucket SHALL specify `bucket_namespace = "account-regional"` on the resource
3. THE Site_Bucket SHALL have public access blocked via `aws_s3_bucket_public_access_block` with all four block settings enabled
4. THE Site_Bucket SHALL have server-side encryption enabled using AES256 (SSE-S3)
5. THE Site_Bucket SHALL have an abort-incomplete-multipart-upload lifecycle rule with a 7-day expiry

### Requirement 2: Origin Access Control

**User Story:** As an infrastructure operator, I want CloudFront to access the S3 bucket via OAC, so that the bucket remains private and only CloudFront can read its contents.

#### Acceptance Criteria

1. THE OAC SHALL be created with signing behavior `always` and signing protocol `sigv4`
2. THE OAC SHALL be scoped to the S3 origin type
3. THE Site_Bucket SHALL have a bucket policy that grants `s3:GetObject` to the CloudFront service principal, conditioned on the Distribution's ARN
4. THE Site_Bucket bucket policy SHALL deny all access except from the Distribution

### Requirement 3: CloudFront S3 Origin and Default Behavior

**User Story:** As a site visitor, I want to access the front-end at the apex domain, so that I can use the application without knowing about the underlying infrastructure.

#### Acceptance Criteria

1. THE Distribution SHALL have a Site_Origin configured with the Site_Bucket's regional domain name and the OAC ID
2. THE Distribution SHALL serve static assets as the default cache behavior (path pattern `*`)
3. THE Distribution default behavior SHALL use a cache policy with a default TTL of 86400 seconds (1 day) and a max TTL of 31536000 seconds (1 year), honouring origin Cache-Control headers
4. THE Distribution default behavior SHALL enable compression (gzip and Brotli)
5. WHEN a request does not match any ordered behavior, THE Distribution SHALL route it to the Site_Origin
6. A CloudFront Function SHALL be attached to the default behavior's viewer-request event that rewrites URIs without a file extension to `/index.html`, enabling SPA client-side routing
7. THE Distribution SHALL NOT use custom error responses (they are distribution-level and would interfere with API error codes)

### Requirement 4: API Path-Based Behavior

**User Story:** As an API consumer, I want API requests to continue routing to the API Gateway origin, so that the API is unaffected by the addition of static hosting.

#### Acceptance Criteria

1. THE Distribution SHALL have an ordered cache behavior with path pattern `/api/*` that routes to the API_Origin
2. THE API Gateway stage SHALL remain as `$default` — no rename needed
3. THE Hono app SHALL be configured with a base path of `/api` so existing route definitions work unchanged
4. THE Distribution `/api/*` behavior SHALL use a custom cache policy that forwards `Authorization`, `Content-Type`, `Origin`, `Accept` headers, all query strings, and the `authorization` cookie
5. THE Distribution `/api/*` behavior SHALL allow all HTTP methods (GET, HEAD, OPTIONS, PUT, PATCH, POST, DELETE)
6. THE Distribution `/api/*` behavior cache policy SHALL have a default TTL of 0 seconds (no caching unless origin sends Cache-Control)
7. THE Distribution `/api/*` behavior SHALL pass the `x-origin-verify` custom header to the API_Origin (existing secret mechanism preserved)

### Requirement 5: Existing Bucket Migration to Account Regional Format

**User Story:** As an infrastructure operator, I want all S3 buckets to use the account regional namespace format, so that bucket names are guaranteed unique to the account and region and cannot be squatted.

#### Acceptance Criteria

1. THE Email_Bucket SHALL be recreated using the Account_Regional_Format (`${var.service_name}-emails-${var.aws_account_id}-eu-west-1-an`) with `bucket_namespace = "account-regional"`
2. THE old Email_Bucket resource SHALL be removed (no migration — no existing data)
3. ALL S3 buckets in the deploy/ directory SHALL use the Account_Regional_Format
4. ALL S3 buckets SHALL specify `bucket_namespace = "account-regional"`

### Requirement 6: CI Deployment Support

**User Story:** As a CI pipeline, I want outputs that identify the Site_Bucket name and CloudFront distribution ID, so that the site repo's GitHub Actions workflow can sync assets and invalidate the cache.

#### Acceptance Criteria

1. THE infrastructure code SHALL output the Site_Bucket name as `site_bucket_name`
2. THE infrastructure code SHALL output the Site_Bucket ARN as `site_bucket_arn`
3. THE infrastructure code SHALL output the CloudFront distribution ID as `cloudfront_distribution_id`
4. THE infrastructure code SHALL output the Email_Bucket name as `email_bucket_name` (updated name)
