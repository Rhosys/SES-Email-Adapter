# Requirements Document

## Introduction

Two new tenant-isolated Lambda functions that execute untrusted workloads in separate execution environments from the main Lambda. This is an explicit exception to the "one Lambda per project" convention because these functions process user-generated JavaScript code and potentially malicious email content — tenant isolation requires separate execution boundaries.

Lambda 1 (User Code Executor) runs user-authored JavaScript functions for rule condition evaluation and template draft value resolution, isolated per accountId. Lambda 2 (Content Sanitizer) parses inbound email, sanitizes HTML, extracts/proxies images and attachments, isolated per sender eTLD+1.

## Glossary

- **Main_Lambda**: The existing single Lambda function (`email-catcher-main`) that handles all API, SQS, and EventBridge entry points
- **User_Code_Executor**: The new Lambda function that executes user-generated JavaScript in isolation, tenant-scoped by accountId
- **Content_Sanitizer**: The new Lambda function that parses, sanitizes, and extracts content from raw SES email messages, tenant-scoped by sender eTLD+1
- **Tenant_ID**: The isolation boundary identifier — accountId for User_Code_Executor, sender eTLD+1 for Content_Sanitizer
- **Extracted_Content_Bucket**: A new S3 bucket storing extracted images and attachments, partitioned by account and sender
- **Extracted_Content_CDN**: A new CloudFront origin serving the Extracted_Content_Bucket via CDN
- **Rule_Condition**: A user-authored JavaScript function `(signal, arc) => value` that evaluates whether a rule matches
- **Template_Function**: A user-authored JavaScript function `(signal, arc) => string` that generates dynamic content for email template drafts
- **Execution_Context**: The data passed to user code — the signal object and arc data relevant to the current processing step
- **DOMPurify**: An HTML sanitization library that strips scripts, event handlers, hidden text, forms, and dangerous elements
- **Tracking_Pixel**: An externally-hosted image embedded in email HTML used to track when/where an email is opened

## Requirements

### Requirement 1: User Code Executor — Invocation

**User Story:** As the email processing pipeline, I want to execute user-authored JavaScript functions in an isolated Lambda, so that untrusted code cannot affect the main Lambda's stability or access other tenants' data.

#### Acceptance Criteria

1. WHEN the Main_Lambda encounters a rule with `conditionType: "js"`, THE Main_Lambda SHALL invoke the User_Code_Executor synchronously with the accountId, the function code, and the Execution_Context
2. WHEN the Main_Lambda resolves template draft function values, THE Main_Lambda SHALL invoke the User_Code_Executor synchronously with the accountId, the function code, and the Execution_Context
3. THE User_Code_Executor SHALL accept a payload containing: tenantId (accountId), functionCode (string, maximum 10,000 characters), executionContext (the signal object and arc object for the current processing step), and purpose ("rule_condition" or "template_function")
4. THE User_Code_Executor SHALL return the function result to the caller as a JSON-serializable value with a maximum serialized size of 256 KB
5. IF the user function throws a runtime exception, THEN THE User_Code_Executor SHALL return a structured error result indicating execution failure, and THE Main_Lambda SHALL treat the result as null
6. IF the payload fails validation (missing required fields, functionCode exceeds 10,000 characters, or purpose is not a recognized value), THEN THE User_Code_Executor SHALL return a structured error result indicating invalid input without executing the function code
7. IF the user function returns a value that cannot be serialized to JSON, THEN THE User_Code_Executor SHALL treat the result as null

### Requirement 2: User Code Executor — Execution Constraints

**User Story:** As a platform operator, I want user code execution to be strictly resource-limited, so that a single tenant's buggy or malicious code cannot consume excessive resources.

#### Acceptance Criteria

1. THE User_Code_Executor SHALL have a timeout of 1 second
2. THE User_Code_Executor SHALL be configured with the minimum available Lambda memory (128 MB)
3. THE User_Code_Executor SHALL execute user code in a sandboxed JavaScript runtime that prevents access to the network, filesystem, and environment variables, and SHALL terminate execution immediately if user code attempts any denied operation
4. IF user code throws an unhandled exception or triggers a sandbox violation, THEN THE User_Code_Executor SHALL return a result indicating failure, including the error message, and SHALL NOT propagate the exception to the caller

### Requirement 3: User Code Executor — Timeout Handling

**User Story:** As a platform operator, I want graceful degradation when user code times out, so that processing continues and the user is informed their code has a bug.

#### Acceptance Criteria

1. IF the User_Code_Executor invocation times out, THEN THE Main_Lambda SHALL log a warning with the accountId, the rule or template identifier, and the timeout duration
2. IF the User_Code_Executor invocation times out for a rule condition, THEN THE Main_Lambda SHALL update the rule record with a comment explaining the code has a bug preventing execution
3. IF the User_Code_Executor invocation times out for a template function, THEN THE Main_Lambda SHALL update the template method record with a comment explaining the code has a bug preventing execution
4. IF the User_Code_Executor invocation times out or returns an execution error, THEN THE Main_Lambda SHALL treat the result as null
5. IF the User_Code_Executor invocation returns a runtime error for a rule condition, THEN THE Main_Lambda SHALL update the rule record with a comment explaining the code has a bug preventing execution
6. IF the User_Code_Executor invocation returns a runtime error for a template function, THEN THE Main_Lambda SHALL update the template method record with a comment explaining the code has a bug preventing execution

### Requirement 4: User Code Executor — Null Semantics

**User Story:** As a rule and template author, I want predictable behavior when my code returns null, so that I understand how null propagates through the system.

#### Acceptance Criteria

1. WHEN the User_Code_Executor returns null or undefined for a rule condition evaluation, THE Main_Lambda SHALL treat the rule as non-matching and skip all actions associated with that rule
2. WHEN the User_Code_Executor returns null or undefined for a template function, THE Main_Lambda SHALL substitute an empty string for that template field value, leave the draft in "draft" status, and skip auto-send of the draft
3. IF the User_Code_Executor returns null or undefined for a template function, THEN THE Main_Lambda SHALL update the template method record with a comment indicating the function returned no value

### Requirement 5: Content Sanitizer — Invocation

**User Story:** As the email processing pipeline, I want to parse and sanitize inbound email content in an isolated Lambda, so that potentially malicious HTML and attachments cannot exploit the main Lambda.

#### Acceptance Criteria

1. WHEN the Main_Lambda receives a new inbound signal, THE Main_Lambda SHALL invoke the Content_Sanitizer synchronously with the S3 key of the raw SES message, the accountId, and the sender eTLD+1 derived from the inbound message envelope
2. THE Content_Sanitizer SHALL accept a payload containing: the S3 key reference to the raw SES message, the accountId, and the sender eTLD+1
3. THE Content_Sanitizer SHALL return the parsed email metadata (from, to, cc, subject, text body, sanitized HTML body, attachment references, headers) to the caller as a JSON-serializable object within the Lambda synchronous invocation response payload
4. IF the Content_Sanitizer returns an error result, THEN THE Main_Lambda SHALL treat the inbound signal as unprocessable and return a retriable error to the caller

### Requirement 6: Content Sanitizer — Email Parsing and Validation

**User Story:** As the email processing pipeline, I want the Content Sanitizer to parse and validate the raw MIME message, so that downstream processing receives structured, validated email data.

#### Acceptance Criteria

1. WHEN the Content_Sanitizer receives a valid MIME message, THE Content_Sanitizer SHALL parse it into structured fields: from, to, cc, replyTo, subject, textBody, htmlBody, attachments, headers, and sentAt
2. WHEN the Content_Sanitizer parses a MIME message where optional fields (replyTo, textBody, htmlBody, sentAt) are absent, THE Content_Sanitizer SHALL omit those fields from the result rather than returning empty or placeholder values
3. IF the Content_Sanitizer receives a malformed MIME message that cannot be parsed, THEN THE Content_Sanitizer SHALL return an error result with a message indicating the parsing failure reason
4. IF the Content_Sanitizer parses a MIME message where the from address is missing or empty, THEN THE Content_Sanitizer SHALL return an error result indicating the sender address is required
5. IF the Content_Sanitizer encounters a MIME message with more than 50 attachments or a total attachment size exceeding 25 MB, THEN THE Content_Sanitizer SHALL return an error result indicating the message exceeds processing limits

### Requirement 7: Content Sanitizer — HTML Sanitization

**User Story:** As a user, I want email HTML to be sanitized before display, so that scripts, tracking pixels, and dangerous elements cannot execute in my browser.

#### Acceptance Criteria

1. WHEN the Content_Sanitizer processes an email with HTML content, THE Content_Sanitizer SHALL sanitize the HTML using DOMPurify
2. THE Content_Sanitizer SHALL strip: script elements, event handler attributes, hidden text elements, form elements, and other dangerous elements as defined by DOMPurify defaults
3. THE Content_Sanitizer SHALL replace all external image URLs (absolute HTTP and HTTPS `src` attributes on `img` elements, excluding `data:` URIs and `cid:` references) in the sanitized HTML with URLs pointing to the proxied copies in the Extracted_Content_Bucket
4. WHEN the Content_Sanitizer encounters `cid:` image references in email HTML, THE Content_Sanitizer SHALL rewrite them to reference the corresponding extracted attachment URL served via the Extracted_Content_CDN
5. THE Content_Sanitizer SHALL remove CSS `url()` declarations that reference external HTTP or HTTPS resources

### Requirement 8: Content Sanitizer — Image Proxying

**User Story:** As a privacy-conscious user, I want external images downloaded at ingestion time and re-hosted through the platform CDN, so that senders cannot use tracking pixels to monitor when and where I read emails.

#### Acceptance Criteria

1. WHEN the Content_Sanitizer encounters an `<img>` element with an absolute HTTP or HTTPS `src` URL in email HTML, THE Content_Sanitizer SHALL download the image at ingestion time
2. IF the downloaded image exceeds 5 MB in size, THEN THE Content_Sanitizer SHALL discard the download, remove the image element from the HTML, and continue processing the remaining images
3. THE Content_Sanitizer SHALL save downloaded images to the Extracted_Content_Bucket at the path `/accounts/{accountId}/senders/{senderEtld1}/extracted/`
4. THE Content_Sanitizer SHALL update the HTML to reference the proxied image URL served via the Extracted_Content_CDN
5. IF an external image download fails or does not complete within 3 seconds, THEN THE Content_Sanitizer SHALL remove the image element from the HTML and continue processing the remaining images

### Requirement 9: Content Sanitizer — Attachment Extraction

**User Story:** As the email processing pipeline, I want attachments extracted and stored separately from the raw MIME message, so that they can be served individually via CDN with appropriate content types.

#### Acceptance Criteria

1. WHEN the Content_Sanitizer processes an email with attachments, THE Content_Sanitizer SHALL extract each attachment and save it to the Extracted_Content_Bucket at the path `/accounts/{accountId}/senders/{senderEtld1}/extracted/` using a unique key that includes a generated identifier to prevent collisions
2. THE Content_Sanitizer SHALL return attachment metadata (filename, mimeType, sizeBytes, s3Key) for each extracted attachment
3. THE Content_Sanitizer SHALL preserve the original filename in the returned metadata and sanitize it for use in the S3 key by removing path separators, directory traversal sequences, and non-printable characters
4. IF saving an individual attachment to S3 fails, THEN THE Content_Sanitizer SHALL skip that attachment, exclude it from the returned metadata, and continue processing remaining attachments
5. THE Content_Sanitizer SHALL skip any individual attachment larger than 10 MB and exclude it from the returned metadata

### Requirement 10: Content Sanitizer — Execution Constraints

**User Story:** As a platform operator, I want the Content Sanitizer to have bounded resource usage, so that processing a single malicious email cannot consume excessive resources.

#### Acceptance Criteria

1. THE Content_Sanitizer SHALL have a timeout of 10 seconds
2. THE Content_Sanitizer SHALL be configured with the minimum available Lambda memory (128 MB)

### Requirement 11: Extracted Content Bucket

**User Story:** As a platform operator, I want a dedicated S3 bucket for extracted email content, so that images and attachments are stored separately from raw email messages with appropriate access controls.

#### Acceptance Criteria

1. THE Extracted_Content_Bucket SHALL be a new S3 bucket partitioned by the path structure `/accounts/{accountId}/senders/{senderEtld1}/extracted/`
2. THE Extracted_Content_Bucket SHALL have public access blocked at the bucket level
3. THE Extracted_Content_Bucket SHALL use server-side encryption (AES256)
4. THE Content_Sanitizer SHALL have write access to the Extracted_Content_Bucket
5. THE Extracted_Content_CDN SHALL have read access to the Extracted_Content_Bucket via Origin Access Control

### Requirement 12: Extracted Content CDN

**User Story:** As a user, I want extracted images and attachments served via CDN, so that email content loads quickly and securely without exposing the S3 bucket directly.

#### Acceptance Criteria

1. THE Extracted_Content_CDN SHALL be a new CloudFront origin added to the existing CloudFront distribution
2. THE Extracted_Content_CDN SHALL serve content from the Extracted_Content_Bucket using Origin Access Control (OAC)
3. THE Extracted_Content_CDN SHALL serve content under the path prefix `/content/*`
4. THE Extracted_Content_CDN SHALL enforce HTTPS-only viewer connections

### Requirement 13: Lambda Infrastructure

**User Story:** As a platform operator, I want the two new Lambda functions deployed with strict resource limits and appropriate IAM permissions, so that they operate with least-privilege access.

#### Acceptance Criteria

1. THE User_Code_Executor SHALL have its own IAM role with no permissions beyond CloudWatch Logs
2. THE Content_Sanitizer SHALL have its own IAM role with permissions limited to: reading from the email S3 bucket, writing to the Extracted_Content_Bucket, and CloudWatch Logs
3. THE Main_Lambda SHALL have permission to invoke both the User_Code_Executor and the Content_Sanitizer synchronously (lambda:InvokeFunction)
4. THE User_Code_Executor and Content_Sanitizer SHALL each have their own CloudWatch log group with 90-day retention

### Requirement 14: Main Lambda Integration

**User Story:** As the email processing pipeline, I want the main Lambda to invoke the isolated Lambdas at the correct points in the processing flow, so that untrusted workloads are delegated before any results are used.

#### Acceptance Criteria

1. WHEN processing an inbound signal, THE Main_Lambda SHALL invoke the Content_Sanitizer before performing classification, arc matching, or rule evaluation
2. WHEN evaluating a rule with `conditionType: "js"`, THE Main_Lambda SHALL invoke the User_Code_Executor instead of evaluating the code locally
3. WHEN resolving template function values for auto-draft generation, THE Main_Lambda SHALL invoke the User_Code_Executor instead of evaluating the code locally
4. IF the Content_Sanitizer invocation fails or times out, THEN THE Main_Lambda SHALL treat the signal as unprocessable and return a retriable error
5. IF the User_Code_Executor invocation fails with a non-timeout error, THEN THE Main_Lambda SHALL log the error with the accountId and function purpose, and treat the result as null
