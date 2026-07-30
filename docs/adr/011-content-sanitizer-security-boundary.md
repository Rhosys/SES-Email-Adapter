# ADR 011: Content Sanitizer Security Boundary

## Status

Accepted

## Context

The email processing pipeline has two Lambda execution contexts:

1. **Processor Lambda** (`src/processor/`) — runs with full IAM permissions: S3 read/write, DynamoDB read/write, SQS send, Bedrock invoke, Lambda invoke, SES send, and more. It orchestrates the entire signal lifecycle.

2. **Content Sanitizer Lambda** (`src/isolated/`) — runs with only `logs:CreateLogStream` and `logs:PutLogEvents` IAM permissions. It receives raw MIME bytes via a presigned GET URL, parses the email, uploads attachments via presigned POST URLs, and returns structured data in its response payload.

Email content is untrusted input from arbitrary senders. Parsing untrusted content (MIME, images, ZIP archives, HTML) exposes the execution context to parser bugs, memory corruption, zip bombs, and other exploits. If a vulnerability in a content-parsing library leads to code execution, the blast radius depends entirely on what IAM permissions are available.

## Decision

All parsing and decoding of untrusted email content MUST happen in the isolated content sanitizer Lambda (`src/isolated/`). The processor Lambda MUST NOT import or use content-parsing libraries directly.

### What stays in `src/isolated/`

- MIME parsing (`mailparser`)
- HTML sanitization (`dompurify`, `happy-dom`)
- Image decoding (`pngjs`, `jpeg-js`)
- QR code scanning (`jsqr`)
- ZIP extraction and PKPass parsing (`jszip`)
- Any future content-parsing library for untrusted email data

### What stays in `src/processor/`

- Orchestration (DynamoDB, S3, SQS, Bedrock, Lambda invoke)
- Structured data from the sanitizer response (already-parsed fields like `from`, `subject`, `assets[]`)
- Business logic (classification, arc matching, rules, side effects)

### How data crosses the boundary

The processor invokes the content sanitizer Lambda via `InvokeCommand`. The sanitizer returns a structured JSON response containing parsed email fields and extracted assets. The processor consumes this response — it never touches raw MIME bytes, image pixels, or ZIP contents.

```
Processor                          Content Sanitizer (isolated)
────────                          ──────────────────────────────
presigned GET URL ──────────────►  fetch raw MIME
presigned POST URL ─────────────►  upload attachments to S3
                                   parse MIME (mailparser)
                                   sanitize HTML (dompurify)
                                   decode images (pngjs, jpeg-js)
                                   scan QR codes (jsqr)
                                   parse PKPass ZIPs (jszip)
                  ◄────────────── { parsed, assets[] }
```

### Enforcement

1. **CLAUDE.md rule** — instructs AI assistants to keep content parsing in `src/isolated/`.
2. **ESLint `no-restricted-imports`** — bans content-parsing libraries from `src/processor/`.
3. **Unit test** — uses `acorn` to parse all `src/processor/**/*.ts` files and fails if any import a banned library.
4. **IAM permissions** — the content sanitizer Lambda role in `deploy/compute.tf` (lines 397–448) grants only CloudWatch Logs access. Even if a parser exploit achieves code execution, it cannot reach S3, DynamoDB, or any other AWS service.

## Consequences

- New content-extraction features (e.g., BCBP decoding, calendar attachment parsing) must be added to `src/isolated/` and their results returned in the sanitizer response.
- The processor cannot lazily fetch and parse attachment bytes from S3 — it must request any needed extraction from the sanitizer upfront.
- The sanitizer Lambda's memory and timeout limits bound how much content can be processed per email. This is an acceptable tradeoff for security isolation.
