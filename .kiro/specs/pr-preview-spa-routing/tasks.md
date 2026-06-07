# Implementation Plan: PR Preview SPA Routing

## Overview

Update the CloudFront Function and Terraform configuration in `deploy/cdn.tf` to support prefix-aware SPA routing for PR previews and versioned main deployments. The implementation adds a second S3 origin for assets, updates the rewrite function to detect `/pr/{slug}/` prefixes, and routes root-level requests through a `main/{year}` prefix.

## Tasks

- [x] 1. Update locals block and add second S3 origin
  - [x] 1.1 Add `site_version` and `s3_assets_origin_id` to the `locals` block in `deploy/cdn.tf`
    - Add `site_version = "main/2026"` to the existing locals block
    - Add `s3_assets_origin_id = "s3-site-assets"` to the existing locals block
    - _Requirements: 2.3_

  - [x] 1.2 Add the `s3-site-assets` origin to the CloudFront distribution
    - Add a new `origin` block pointing to the same S3 bucket (`aws_s3_bucket.web`)
    - Set `origin_id = local.s3_assets_origin_id`
    - Set `origin_path = "/${local.site_version}"`
    - Use the same OAC (`aws_cloudfront_origin_access_control.s3.id`)
    - _Requirements: 2.4_

  - [x] 1.3 Update the `/assets/*` ordered cache behavior to use the new origin
    - Change `target_origin_id` from `local.s3_site_origin_id` to `local.s3_assets_origin_id`
    - _Requirements: 2.4_

- [x] 2. Implement prefix-aware CloudFront Function
  - [x] 2.1 Replace the `aws_cloudfront_function.spa_rewrite` code with the new rewrite logic
    - Replace the existing `code` heredoc with the new function that:
      - Detects `/pr/{slug}/` prefix and rewrites SPA routes to `/pr/{slug}/index.html`
      - Passes through PR static files (final segment has dot) unchanged
      - Passes through bare `/pr/` and `/pr` unchanged
      - Rewrites root-level SPA routes to `/${local.site_version}/index.html`
      - Prepends `/${local.site_version}` to root-level static file URIs
    - Use HCL heredoc interpolation (`${local.site_version}`) so the year is injected at plan time
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 3.1, 3.2, 4.1, 4.2_

- [x] 3. Checkpoint — Validate Terraform configuration
  - Ensure `tofu plan` completes without errors against the deploy configuration, ask the user if questions arise.

- [x] 4. Property-based tests for the rewrite function
  - [x] 4.1 Create test file with the rewrite function extracted for testing
    - Create a test file (e.g. `email-catcher/backend/src/cdn/spa-rewrite.test.ts`)
    - Extract the CloudFront Function logic into a testable pure function
    - Set up fast-check imports and test structure
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2_

  - [x] 4.2 Write property test for PR prefix deep-link routing
    - **Property 1: PR prefix deep-link routing**
    - Generate random slugs (`[a-z0-9-]`, 1–63 chars) and random route paths where the final segment has no dot
    - Assert the function rewrites to `/pr/{slug}/index.html`
    - Also generate paths where the final segment has a dot and assert pass-through
    - **Validates: Requirements 1.1, 1.3**

  - [x] 4.3 Write property test for root-level SPA routing
    - **Property 2: Root-level SPA routing**
    - Generate random URI paths not starting with `/pr/`
    - Assert SPA routes (no dot in final segment) rewrite to `/main/2026/index.html`
    - Assert static files (dot in final segment) rewrite to `/main/2026{original_uri}`
    - **Validates: Requirements 2.1, 2.2**

  - [x] 4.4 Write property test for bare prefix rewrite
    - **Property 3: Bare prefix rewrite regardless of slug content**
    - Generate random non-empty slugs including those with dot characters (e.g. `v1.2-fix`)
    - Assert `/pr/{slug}` rewrites to `/pr/{slug}/index.html`
    - Assert `/pr/{slug}/` rewrites to `/pr/{slug}/index.html`
    - **Validates: Requirements 1.2, 3.1**

  - [x] 4.5 Write example-based tests for edge cases
    - Test `/pr/` passes through unchanged (Requirement 1.4)
    - Test `/pr` passes through unchanged (Requirement 1.4)
    - Test static test cases from the design document
    - **Validates: Requirements 1.4, 3.2**

- [x] 5. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The implementation language is HCL (Terraform) for infrastructure and JavaScript for the CloudFront Function code
- Property tests use `fast-check` (already in the project) with Vitest
- The `VITE_BASE_PATH=/` change for main builds is a CI configuration concern outside this Terraform scope — asset paths will be `/assets/...` which match the `/assets/*` ordered behavior directly
- `${local.site_version}` is interpolated by Tofu at plan time via the heredoc — the deployed function contains the literal string `main/2026`
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5"] }
  ]
}
```
