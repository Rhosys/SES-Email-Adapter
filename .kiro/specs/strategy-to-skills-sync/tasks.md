# Implementation Plan

## Overview

Sync 33 unpushed commits from `_Strategy/` into the corresponding Kiro skills at `~/.kiro/skills/`. Process 7 changed Strategy files into 6 skills (one new). Each skill gets one commit after validation.

## Tasks

- [x] 1. Sync 005-conventions — add new rules from conventions.md and testing.md
  - [x] 1.1 Read source files and current skill
    - Read `~/.kiro/skills/005-conventions/SKILL.md` in full
    - Read `_Strategy/conventions.md` (current HEAD) and `_Strategy/patterns/testing.md` for source content
    - _Requirements: 1(AC1), 3(AC1)_

  - [x] 1.2 Add new sections and update existing ones
    - Add sections: Architecture rules (one Lambda, one dep per concern, DB is data access only, all DI present), Observability (no metrics, structured logs, full error+input), Scope discipline, Refactoring approach (smallest piece first), Design discipline (24 anti-pattern rules condensed), Testing (meaningful variability table, deletion test, no random generation, `it.each`), DynamoDB call optimization, Frontend work tracking (TODO-UI.md), Never start with broken tests
    - Update Git staging discipline: ban `git add .`/`-A`/`--all`, commit timing, never amend without approval
    - Update Session start checklist: add ADR reading as step 4
    - Add "What's next" uses TODO.md section
    - _Requirements: 3(AC2-7), 5(AC1-7), 9(AC2,4)_

  - [x] 1.3 Validate and commit
    - Validate: frontmatter intact, prefix line present, ≤400 lines
    - Run `npm run check` in skills directory if script exists
    - Commit: `🟣 Sync 005-conventions: design discipline, observability, DI, testing, DynamoDB, git staging`
    - _Requirements: 7(AC1-2), 8(AC1-5)_

- [x] 2. Sync 006-javascript — update type system, error handling, code style, testing
  - [x] 2.1 Read source files and current skill
    - Read `~/.kiro/skills/006-javascript/SKILL.md` in full
    - Read `_Strategy/languages/javascript.md` and `_Strategy/patterns/testing.md` for source content
    - _Requirements: 1(AC1)_

  - [x] 2.2 Update sections
    - Update Type system: add I-prefix rule for interfaces/types
    - Update Error handling: never throw (always err()), never return raw Error, default Result<T,string> or ResultAsync<T,E>
    - Update Code style: no else blocks, keep condition/construction/side-effect together, name by business purpose
    - Add/update Testing section: one file per concern, `it.each`, observable behaviour assertions, no fake timers, no purposeless setup
    - _Requirements: 3(AC2-4), 9(AC1,3)_

  - [x] 2.3 Dedup check, validate, and commit
    - Grep 005-conventions to confirm no duplicated rules (meaningful variability, deletion test, no random generation must NOT be in 006)
    - Validate: frontmatter intact, prefix line present, ≤400 lines
    - Commit: `🟣 Sync 006-javascript: I-prefix, never throw, no else, testing structure`
    - _Requirements: 9(AC4), 7(AC1-2), 8(AC1-5)_

- [x] 3. Sync 002-aws-terraform — add deployment boundary, S3 naming, CloudFront, import blocks
  - [x] 3.1 Read source files and current skill
    - Read `~/.kiro/skills/002-aws-terraform/SKILL.md` in full
    - Read `_Strategy/languages/terraform.md` for source content
    - _Requirements: 1(AC1)_

  - [x] 3.2 Add new sections
    - Add sections: Deployment boundary (lifecycle ownership tables, no data sources for owned resources), S3 bucket naming (account-regional namespace, HCL example), CloudFront S3 origin via OAC (OAC resource + bucket policy HCL), CloudFront S3 default behavior SPA (compression, cache, CloudFront Function, no custom error responses, no static website hosting), API Gateway → Lambda (resource-based policy only, HCL example), Importing existing resources (always import blocks, never CLI, HCL example)
    - Update existing naming section: S3 bucket format now includes account-regional namespace
    - _Requirements: 3(AC3,4,7), 5(AC4,5)_

  - [x] 3.3 Validate and commit
    - Validate: frontmatter intact, prefix line present, ≤400 lines
    - Commit: `🟣 Sync 002-aws-terraform: deployment boundary, S3 naming, CloudFront, import blocks`
    - _Requirements: 7(AC1-2), 8(AC1-5)_

- [x] 4. Sync 004-secrets — add cross-repo encryption, runtime vs deployment, cold-start pattern
  - [x] 4.1 Read source files and current skill
    - Read `~/.kiro/skills/004-secrets/SKILL.md` in full
    - Read `_Strategy/secrets.md` for source content
    - _Requirements: 1(AC1)_

  - [x] 4.2 Update and add sections
    - Update "Encrypting a secret" section: add --origin flag, replace examples with same-repo and cross-repo patterns
    - Add sections: Deployment-time vs runtime secrets (table), Cold-start decryption pattern (TypeScript code example with lazy singleton), rules about never decrypting runtime secrets during deployment and never using env vars for secrets
    - _Requirements: 3(AC3,4), 5(AC4)_

  - [x] 4.3 Validate and commit
    - Validate: frontmatter intact, prefix line present, ≤400 lines
    - Commit: `🟣 Sync 004-secrets: cross-repo encryption, runtime vs deployment, cold-start`
    - _Requirements: 7(AC1-2), 8(AC1-5)_

- [x] 5. Sync 012-api-patterns — add sub-resource inlining, branded hostnames, no synthetic UUIDs
  - [x] 5.1 Read source files and current skill
    - Read `~/.kiro/skills/012-api-patterns/SKILL.md` in full
    - Read `_Strategy/patterns/api.md` for source content
    - _Requirements: 1(AC1)_

  - [x] 5.2 Add new sections
    - Add sections: Sub-resource data belongs on the parent (inline on GET, expensive ops on mutation only), Branded hostnames over raw provider endpoints ({record}.platform.{zone} pattern), No synthetic UUIDs for naturally unique resources (use natural keys, examples)
    - _Requirements: 3(AC3,7), 5(AC1,3)_

  - [x] 5.3 Validate and commit
    - Validate: frontmatter intact, prefix line present, ≤400 lines
    - Commit: `🟣 Sync 012-api-patterns: sub-resource inlining, branded hostnames, no synthetic UUIDs`
    - _Requirements: 7(AC1-2), 8(AC1-5)_

- [x] 6. Create 013-resilience — new skill from patterns/resilience.md
  - [x] 6.1 Read source content
    - Read `_Strategy/patterns/resilience.md` for source content
    - _Requirements: 1(AC2)_

  - [x] 6.2 Create new skill file
    - Create `~/.kiro/skills/013-resilience/SKILL.md` with frontmatter (name: 013-resilience, description about retry-safe workers/queue consumers/pipelines)
    - Add H1 title `# 013-RESIL — Resilience & Retry Architecture` and prefix instruction
    - Add 9 numbered principles as condensed directives: (1) don't track state when idempotent, (2) idempotency over bookkeeping, (3) separate by failure domain, (4) convention not configuration, (5) pass raw data derive at execution, (6) inline exceptional path, (7) don't invent new interfaces, (8) defer complexity until evidence, (9) save leaf nodes first — never DynamoDB transactions
    - _Requirements: 4(AC1-5), 5(AC1,3,6)_

  - [x] 6.3 Update registry and commit
    - Update `~/.kiro/skills/000-skill-management/SKILL.md` registry: add 013-RESIL row, update next number to 014
    - Validate: frontmatter intact, prefix line present, ≤400 lines
    - Commit: `🟣 Create 013-resilience: retry architecture patterns`
    - _Requirements: 7(AC1-2), 8(AC1-5)_

- [x] 7. Final validation — deduplication check and completeness audit
  - [x] 7.1 Deduplication grep check
    - Grep all SKILL.md files for key terms: "random generation" (only in 005), "meaningful variability" (only in 005), "deletion test" (only in 005), "never throw" (only in 006), "idempotency over bookkeeping" (only in 013)
    - _Requirements: 7(AC1-4), 9(AC4)_

  - [x] 7.2 Line count and completeness check
    - Verify no SKILL.md exceeds 400 lines (`wc -l ~/.kiro/skills/*/SKILL.md`)
    - Spot-check 5 rules from each changed Strategy file to confirm they appear in a skill
    - Run final `npm run check` in skills directory if script exists
    - _Requirements: 7(AC1-4), 9(AC5)_

## Notes

- The skills directory is at `~/.kiro/skills/` (symlinked to `~/git/claude/_skills`)
- `CLAUDE.md` changes (1 line) are excluded from sync per Requirement 6
- `patterns/caches.md` had no changes in these 33 commits — no action needed for 012-api-patterns cache sections
- If 005-conventions exceeds 400 lines, condense design anti-patterns further or move DynamoDB optimization to 012-api-patterns
- Pre-commit gate: check `~/.kiro/skills/package.json` for available scripts before first commit

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["2.1", "3.1", "4.1", "5.1", "6.1"] },
    { "id": 4, "tasks": ["2.2", "3.2", "4.2", "5.2", "6.2"] },
    { "id": 5, "tasks": ["2.3", "3.3", "4.3", "5.3", "6.3"] },
    { "id": 6, "tasks": ["7.1"] },
    { "id": 7, "tasks": ["7.2"] }
  ]
}
```
