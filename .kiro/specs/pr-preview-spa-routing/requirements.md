# Requirements Document

## Introduction

The email-catcher front-end SPA deploys PR previews under `pr/{slug}/` in S3. The existing CloudFront Function performs a naive SPA rewrite — any URI without a file extension becomes `/index.html`. This breaks deep links for PR preview deployments because the rewrite ignores the deployment prefix, sending the browser to the root `index.html` instead of the one within the correct prefix directory.

This feature updates the CloudFront Function to detect the `pr/{slug}/` deployment prefix and rewrite non-file URIs to the correct `index.html` within that prefix, while preserving backward compatibility for root-level requests.

## Glossary

- **SPA_Rewrite_Function**: The CloudFront Function (viewer-request) that rewrites URIs for single-page application routing
- **Deployment_Prefix**: The S3 key prefix under which a PR build is published (`pr/{slug}`)
- **Deep_Link**: A URL path that targets a client-side route within the SPA (e.g. `/pr/my-branch/dashboard`)
- **File_URI**: A URI whose last path segment contains a dot, indicating a static file (e.g. `/pr/my-branch/assets/index-abc123.js`)
- **Root_Request**: A URI that does not begin with `/pr/`

## Requirements

### Requirement 1: Prefix-aware SPA rewrite for PR previews

**User Story:** As a developer reviewing a PR preview, I want deep links within the preview to load the correct SPA entry point, so that I can share and bookmark specific routes.

#### Acceptance Criteria

1. WHEN a request URI matches the pattern `/pr/{slug}/{route}` where `{route}` is one or more path segments and the final path segment does not contain a dot (`.`), THE SPA_Rewrite_Function SHALL rewrite the URI to `/pr/{slug}/index.html`, preserving any query string present on the original request
2. WHEN a request URI matches the pattern `/pr/{slug}/` (trailing slash, no further path) or `/pr/{slug}` (no trailing slash, no further path), THE SPA_Rewrite_Function SHALL rewrite the URI to `/pr/{slug}/index.html`
3. WHEN a request URI matches the pattern `/pr/{slug}/{path}` where `{path}` is one or more path segments and the final path segment contains a dot (`.`), THE SPA_Rewrite_Function SHALL pass the URI through unchanged
4. IF a request URI starts with `/pr/` but contains no `{slug}` segment (i.e., the path is exactly `/pr/` or `/pr`), THEN THE SPA_Rewrite_Function SHALL pass the URI through unchanged

### Requirement 2: Root-level request routing via main prefix

**User Story:** As a user visiting the site at the root domain, I want my requests to resolve to the current production build in S3, so that the app loads correctly without me knowing about the internal bucket structure.

#### Acceptance Criteria

1. WHEN a request URI does not begin with `/pr/`, and the final path segment does not contain a dot character, THE SPA_Rewrite_Function SHALL rewrite the URI path to `/main/{YEAR}/index.html` where `{YEAR}` is a hardcoded constant in the function code (currently `2026`)
2. WHEN a request URI does not begin with `/pr/`, and the final path segment contains a dot character, THE SPA_Rewrite_Function SHALL rewrite the URI path to `/main/{YEAR}{original_uri}` (prepending the main prefix to the original path)
3. THE `{YEAR}` value SHALL be defined once as `local.site_version` in the Tofu `locals` block and referenced by both the CF function code and the assets origin path — updated in one place per calendar year
4. THE `/assets/*` ordered cache behavior SHALL use a separate S3 origin with `origin_path = "/${local.site_version}"` so that asset requests resolve to the correct S3 keys without function involvement

### Requirement 3: Prefix-only requests

**User Story:** As a developer, I want requests to the bare prefix path (without trailing slash) to also resolve correctly, so that URLs work regardless of trailing slash presence.

#### Acceptance Criteria

1. WHEN a request URI has exactly two path segments matching `/pr/{slug}` (no trailing slash) where `{slug}` is a non-empty path segment, THE SPA_Rewrite_Function SHALL rewrite the URI to `/pr/{slug}/index.html` regardless of whether the slug contains a dot
2. IF the path segment following `/pr/` is empty (e.g. the URI is exactly `/pr/`), THEN THE SPA_Rewrite_Function SHALL pass the URI through to the default rewrite behaviour defined in Requirement 2

### Requirement 4: Terraform resource update

**User Story:** As an infrastructure maintainer, I want the CloudFront Function code in Terraform to reflect the new rewrite logic, so that the function is deployed and versioned through the standard IaC pipeline.

#### Acceptance Criteria

1. THE `aws_cloudfront_function.spa_rewrite` resource in `deploy/cdn.tf` SHALL contain the rewrite logic as inline HCL code (using the `code` attribute) with `publish = true`
2. THE `aws_cloudfront_function.spa_rewrite` resource SHALL use the `cloudfront-js-2.0` runtime
3. THE `aws_cloudfront_function.spa_rewrite` resource SHALL remain associated with the `default_cache_behavior` block via a `function_association` of event type `viewer-request`
4. WHEN `tofu plan` is run against the deploy configuration, THE plan SHALL complete without errors
