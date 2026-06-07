# Tasks

## Task 1: Add retention types and utility functions

- [x] Create `src/processor/retention.ts` with:
  - `RetentionDuration` type union: `"P1M" | "P2M" | "P3M" | "P5M" | "P6M" | "P1Y" | "P2Y" | "P5Y" | "P10Y" | "P100Y" | "Infinity"`
  - `S3RetentionTag` type: `"365" | "3650" | null`
  - `retentionToS3Tag(duration: RetentionDuration): S3RetentionTag` — maps duration to lifecycle tag
  - `durationToSeconds(duration: RetentionDuration): number | null` — returns epoch-offset seconds, null for forever
  - `resolveRetention(accountCtx, emailConfig, ruleOverride?): RetentionDuration` — priority: rule > alias > account > default (P1Y)
- [x] Add `retentionDuration?: RetentionDuration` and update `ttl` computation in `src/types/index.ts` for Signal and Arc types
- [x] Write tests for `retentionToS3Tag` and `durationToSeconds` covering all enum values

## Task 2: Infrastructure — Extracted content S3 bucket

- [x] Create `deploy/content_storage.tf` with:
  - `aws_s3_bucket.extracted_content` (account-regional namespace)
  - `aws_s3_bucket_public_access_block.extracted_content` (all blocked)
  - `aws_s3_bucket_server_side_encryption_configuration.extracted_content` (AES256)
  - `aws_s3_bucket_lifecycle_configuration.extracted_content`:
    - Abort incomplete multipart uploads (7 days)
    - `expire-1-year`: tag `retention=365` → 365 days
    - `expire-10-years`: tag `retention=3650` → 3650 days
    - No rule for forever (untagged objects persist indefinitely)

## Task 3: Infrastructure — CloudFront origin for `/content/*`

- [x] Add S3 origin `s3-content` to `aws_cloudfront_distribution.api` in `deploy/cdn.tf`
- [x] Add `aws_cloudfront_origin_access_control.content` for the new bucket
- [x] Add `ordered_cache_behavior` for path pattern `/content/*`:
  - Allowed methods: GET, HEAD
  - Target: `s3-content`
  - Viewer protocol: redirect-to-https
  - Cache policy: 1 year default TTL (immutable content)
- [x] Add `aws_cloudfront_cache_policy.content_cache` (1 year default/max TTL, no cookies, no headers, no query strings)
- [x] Add `aws_s3_bucket_policy.extracted_content` granting CloudFront OAC `s3:GetObject`

## Task 4: Infrastructure — User Code Executor Lambda

- [x] Add to `deploy/compute.tf`:
  - `aws_iam_role.user_code_executor` (assume role for lambda.amazonaws.com)
  - `aws_iam_role_policy.user_code_executor` (CloudWatch Logs only)
  - `aws_cloudwatch_log_group.user_code_executor` (90-day retention)
  - `aws_lambda_function.user_code_executor` (nodejs24.x, 128MB, 1s timeout)
- [x] Add `lambda:InvokeFunction` for `user_code_executor` ARN to Main Lambda's IAM policy

## Task 5: Infrastructure — Content Sanitizer Lambda

- [x] Add to `deploy/compute.tf`:
  - `aws_iam_role.content_sanitizer` (assume role for lambda.amazonaws.com)
  - `aws_iam_role_policy.content_sanitizer` (CloudWatch Logs only — no S3 permissions)
  - `aws_cloudwatch_log_group.content_sanitizer` (90-day retention)
  - `aws_lambda_function.content_sanitizer` (nodejs24.x, 128MB, 10s timeout)
- [x] Add `lambda:InvokeFunction` for `content_sanitizer` ARN to Main Lambda's IAM policy
- [x] Add `s3:PutObject` + `s3:PutObjectTagging` on `extracted_content` bucket to Main Lambda's IAM policy (required for pre-signed POST generation)

## Task 6: Build system — esbuild entry points for isolated Lambdas

- [x] Update `make.ts` to add two new esbuild bundle targets:
  - `src/isolated/user-code-executor.ts` → `dist/user-code-executor.js`
  - `src/isolated/content-sanitizer.ts` → `dist/content-sanitizer.js`
- [x] Each target produces a separate zip artifact for deployment
- [x] Update `.gitlab-ci.yml` to deploy both new Lambda zips alongside the main Lambda

## Task 7: Implement User Code Executor Lambda handler

- [x] Create `src/isolated/user-code-executor.ts`:
  - Validate payload: `tenantId`, `purpose` (must be `rule_condition` or `template_function`), `functionCode` (≤ 10,000 chars), `executionContext`
  - Return `UserCodeError` with `type: "invalid_input"` on validation failure
  - Create `vm.createContext()` with frozen `signal` and `arc` globals, no other globals
  - Compile and run `functionCode` with 800ms timeout via `vm.runInContext()`
  - On success: return `RuleExecutionResult` or `TemplateParameterResult` based on `purpose`
  - On timeout: return `UserCodeError` with `type: "timeout"`
  - On runtime error: return `UserCodeError` with `type: "runtime_error"` and error message
  - On serialization failure: return result as `null`
- [x] Create `src/isolated/js-container.ts` — wraps `vm` module with context stripping and timeout
- [x] Write tests for the handler covering: valid execution, timeout, runtime error, sandbox violation, invalid input, non-serializable return

## Task 8: Implement Content Sanitizer Lambda handler

- [x] Create `src/isolated/content-sanitizer.ts`:
  - Fetch raw MIME via `presignedGetUrl` using native `fetch`
  - Parse with `mailparser` (import `MailparserMimeParser`)
  - Validate: from present, attachment count ≤ 50, total size ≤ 25MB
  - Return `ContentSanitizeError` on validation failure
  - Extract attachments: upload each via pre-signed POST with integer key suffix (0, 1, 2...)
  - Skip attachments > 10MB, skip on upload failure
  - Sanitize HTML via `html-sanitizer.ts`
  - Download external images (3s timeout, 5MB max), upload via pre-signed POST (continuing index)
  - Build `urlMapping`: original URL → `/content/{s3Key}`
  - Map `cid:` references to corresponding attachment CDN paths
  - Return `ContentSanitizeResponse` with parsed fields, urlMapping, and attachment refs
- [x] Create `src/isolated/html-sanitizer.ts`:
  - Configure DOMPurify with jsdom: strip scripts, event handlers, forms, hidden elements
  - Remove CSS `url()` declarations referencing external HTTP(S) resources
  - Extract all external `<img src>` URLs (HTTP/HTTPS, excluding `data:` and `cid:`)
  - Extract all `cid:` references
  - Return sanitized HTML + list of external image URLs + list of cid references
- [x] Write tests for html-sanitizer covering: script removal, event handler removal, external image extraction, cid extraction, CSS url() removal, hidden text removal

## Task 9: Implement pre-signed URL generation in Main Lambda

- [x] Add `@aws-sdk/s3-request-presigner` and `@aws-sdk/s3-presigned-post` to `package.json`
- [x] Create `src/processor/presign.ts`:
  - `generatePresignedGet(bucket, key): Promise<string>` — 30s expiry
  - `generatePresignedPost(bucket, keyPrefix, retentionTag): Promise<{ url, fields }>` — 30s expiry, `starts-with` condition on prefix, 10MB content-length-range, tagging condition
- [x] Write tests for presign module (mock S3 client, verify conditions are set correctly)

## Task 10: Integrate Content Sanitizer into processor pipeline

- [x] Create `ContentSanitizerClient` interface and `LambdaContentSanitizer` implementation in `src/processor/content-sanitizer-client.ts`:
  - `invoke(request: ContentSanitizeRequest): Promise<Result<ContentSanitizeResponse, DbError>>`
  - Wraps `LambdaClient.invoke()` with JSON parse of response payload
  - Maps Lambda timeout/error to `DbError`
- [x] Add `contentSanitizer: ContentSanitizerClient` to `SignalProcessorOptions`
- [x] Replace `this.mimeParser.parse(s3Key)` call in `processMessage()` with:
  - Resolve retention duration
  - Generate pre-signed GET and POST
  - Invoke Content Sanitizer
  - Apply `urlMapping` replacements to `htmlBody`
- [x] Remove `S3MimeParser` class from `handler.ts` (no longer needed)
- [x] Update `handler.ts` composition root to wire `LambdaContentSanitizer` with the Lambda function ARN from env var

## Task 11: Integrate User Code Executor into rule evaluator

- [x] Create `UserCodeExecutorClient` interface and `LambdaUserCodeExecutor` implementation in `src/processor/user-code-client.ts`:
  - `invoke(request: UserCodeRequest): Promise<UserCodeResponse>`
  - Wraps `LambdaClient.invoke()` with JSON parse
  - On Lambda timeout: returns `UserCodeError` with `type: "timeout"`
- [x] Add `userCodeExecutor: UserCodeExecutorClient` to `JsonLogicRuleEvaluator` (or create a new composite evaluator)
- [x] In `evaluate()`: if `rule.conditionType === "js"`, invoke User Code Executor instead of `evalCondition`
- [x] On error/timeout: call `annotateRuleError(rule, error)` — updates rule record with comment field
- [x] Add `annotateRuleError` method that writes a `lastError` comment to the rule via the store
- [x] Write tests for the JS rule evaluation path: success (truthy), success (falsy/null), timeout, runtime error

## Task 12: Integrate User Code Executor into template function resolution

- [x] Locate template function resolution in side-effect processing (likely in `processSideEffect` or a notifier)
- [x] For each template function: invoke User Code Executor with `purpose: "template_function"`
- [x] On null result or error: set `preventAutoSend = true`, substitute empty string, annotate template
- [x] Add `annotateTemplateError` method that writes a `lastError` comment to the template function record
- [x] Write tests for template function resolution: success, null return (prevents auto-send), timeout, runtime error

## Task 13: Wire environment variables and composition root

- [x] Add env vars to Main Lambda in `deploy/compute.tf`:
  - `USER_CODE_EXECUTOR_ARN` → `aws_lambda_function.user_code_executor.arn`
  - `CONTENT_SANITIZER_ARN` → `aws_lambda_function.content_sanitizer.arn`
  - `CONTENT_BUCKET` → `aws_s3_bucket.extracted_content.bucket`
  - `CONTENT_CDN_BASE_URL` → constructed from CloudFront distribution domain + `/content`
- [x] Update `handler.ts` to read these env vars and wire into the processor's composition root
- [x] Verify `npm run build` passes with all new files
- [x] Verify `npm run test` passes with all new tests
