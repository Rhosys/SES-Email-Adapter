# Claude Instructions

## Todos
Always track todos in `TODO.md` at the repo root. When adding, completing, or removing tasks, update `TODO.md` directly — do not rely solely on in-memory TodoWrite. TodoWrite may be used alongside it, but `TODO.md` is the source of truth.

## Security Boundary: Isolated Content Sanitizer

All parsing and decoding of untrusted email content (MIME parsing, image decoding, QR scanning, ZIP extraction, PKPass parsing) MUST happen inside `src/isolated/`, which runs as the content sanitizer Lambda with only CloudWatch Logs IAM permissions. The processor (`src/processor/`) runs with full IAM (S3, DynamoDB, SQS, Bedrock, Lambda invoke) and must NEVER import or use content-parsing libraries directly. Results from content parsing reach the processor exclusively via the sanitizer Lambda's response payload. See `docs/adr/011-content-sanitizer-security-boundary.md` for the full rationale.

Banned imports in `src/processor/`: `jsqr`, `pngjs`, `jpeg-js`, `jszip`, `mailparser`, `dompurify`, `happy-dom`, `node:crypto` (for content hashing of untrusted data). If you need to extract data from email content, add the extraction logic to `src/isolated/` and return the results in the sanitizer response.

## Behaviour
- GitHub Actions step summaries render ANSI color codes. Do not strip color from CLI tool output destined for `$GITHUB_STEP_SUMMARY`.
