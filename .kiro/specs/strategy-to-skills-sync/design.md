# Design Document

## Overview

This is a manual agent-driven sync operation — not an automated script. The agent reads each Strategy file diff, identifies the corresponding skill, and applies the condensed changes to the SKILL.md file using `str_replace` / `fs_write`. Each skill gets one commit.

The sync covers 7 changed Strategy files mapping to 6 skills (one new):

| Strategy file | Skill | Change type |
|---|---|---|
| `conventions.md` | `005-conventions` | content_modified (169 lines added) |
| `languages/javascript.md` | `006-javascript` | content_modified (8 lines added) |
| `languages/terraform.md` | `002-aws-terraform` | content_modified (154 lines added) |
| `patterns/api.md` | `012-api-patterns` | content_modified (33 lines added) |
| `patterns/resilience.md` | `013-resilience` (NEW) | new_file (77 lines) |
| `patterns/testing.md` | `005-conventions` + `006-javascript` (split) | new_file (43 lines) |
| `secrets.md` | `004-secrets` | content_modified (47 lines added) |

`CLAUDE.md` (1 line added) is excluded per Requirement 6.

---

## Architecture

The sync is a sequential, agent-driven process with no runtime components. The "system" is the agent executing tasks against the filesystem.

```
┌─────────────────────┐         ┌──────────────────────┐
│  _Strategy/ repo    │         │  ~/.kiro/skills/     │
│  (source of truth)  │         │  (target)            │
│                     │         │                      │
│  conventions.md ────┼────────►│  005-conventions/    │
│  languages/js.md ───┼────────►│  006-javascript/     │
│  languages/tf.md ───┼────────►│  002-aws-terraform/  │
│  patterns/api.md ───┼────────►│  012-api-patterns/   │
│  secrets.md ────────┼────────►│  004-secrets/        │
│  patterns/resil.md ─┼────────►│  013-resilience/ NEW │
│  patterns/test.md ──┼──split─►│  005 + 006           │
└─────────────────────┘         └──────────────────────┘
```

Execution order (cross-cutting first, then domain-specific):
1. `005-conventions`
2. `006-javascript`
3. `002-aws-terraform`
4. `004-secrets`
5. `012-api-patterns`
6. `013-resilience` (create)

Each step: read Strategy diff → condense → apply to SKILL.md → validate → commit.

---

## Components and Interfaces

No code components — this is a file-editing operation. The "interfaces" are the SKILL.md file format:

### SKILL.md Structure

```markdown
---
name: NNN-slug
description: Single sentence, max 200 chars.
---

# NNN-CODE — Human-Readable Name

**Prefix every response where this skill is active with `NNN-CODE`.**

---

## Section Heading

- Rule as imperative directive
- Another rule

---

## Another Section

...
```

### Mapping Table (Component → Target)

| Strategy path | Skill directory | Short code |
|---|---|---|
| `conventions.md` | `005-conventions` | `005-CONVN` |
| `languages/javascript.md` | `006-javascript` | `006-JS` |
| `languages/terraform.md` | `002-aws-terraform` | `002-AWS` |
| `patterns/api.md` | `012-api-patterns` | `012-API` |
| `secrets.md` | `004-secrets` | `004-SECRET` |
| `patterns/resilience.md` | `013-resilience` | `013-RESIL` |
| `patterns/testing.md` | split: `005` + `006` | — |

---

## Data Models

No runtime data models. The only "data" is the SKILL.md file content. The transformation rules define how Strategy prose becomes skill directives:

### Transformation Rules

| Strategy element | Skill output |
|---|---|
| Multi-paragraph explanation | Single-line imperative directive |
| "Why:" block (non-load-bearing) | Dropped |
| "Why:" block (contains constraint needed to apply rule) | Inlined into directive |
| Fenced code block | Preserved verbatim |
| Markdown table | Preserved verbatim |
| Section header (`##`, `###`) | Preserved as-is |
| Numbered list of principles | Numbered list with bold lead + one-sentence directive |

### New Skill 013-resilience Frontmatter

```yaml
---
name: 013-resilience
description: Resilience and retry architecture patterns. Use when designing retry-safe workers, queue consumers, or multi-step pipelines.
---
```

---

## Detailed Changes Per Skill

### 005-conventions — New Sections

1. **One Lambda per project** — single Lambda handles all entry points
2. **One dependency per concern** — check existing deps before adding new ones
3. **Database layer is data access only** — no business logic in DB classes
4. **Observability** — no CloudWatch metrics, structured logs only, full error + input in logs
5. **All DI properties always present** — never optional deps, never env var fallbacks
6. **Scope discipline** — don't modify test files or refactor unasked code
7. **Refactoring approach** — smallest piece first, each piece compiles and gets own commit
8. **Design discipline anti-patterns** (24 rules from conventions.md diff)
9. **Never start with broken tests** — fix immediately before new work
10. **"What's next" uses TODO.md** — single source of truth, remove completed items
11. **Session start checklist** — add ADR reading as step 4
12. **Git staging** — ban `git add .` / `-A` / `--all`, explicit timing rule
13. **Never amend without approval** — always new commit by default
14. **DynamoDB call optimization** — batch reads, conditional writes, no read-before-write
15. **Frontend work tracking (TODO-UI.md)** — capture frontend work after backend completion
16. **Testing (language-agnostic)** — meaningful variability, deletion test, no random generation, `it.each` labelling

### 006-javascript — Updates

1. **Type system** — add: all interfaces/types start with capital `I`
2. **Error handling** — add: never `throw`, always `err()`; never return raw `Error`; default `Result<T, string>` or `ResultAsync<T, E>`
3. **Code style** — add: no `else` blocks, keep condition/construction/side-effect together, name by business purpose
4. **Testing (JS-specific)** — one file per concern, `it.each`, observable behaviour assertions, no fake timers, no purposeless setup

### 002-aws-terraform — New Sections

1. **Deployment boundary** — lifecycle ownership table
2. **S3 bucket naming** — account regional namespace format with HCL example
3. **CloudFront — S3 origin via OAC** — OAC resource + bucket policy HCL
4. **CloudFront — S3 default behavior (SPA)** — compression, cache, CloudFront Function
5. **API Gateway → Lambda** — resource-based policy only, HCL example
6. **Importing existing resources** — always `import` blocks, never CLI

### 004-secrets — New Sections + Update

1. **Update "Encrypting a secret"** — add `--origin` flag for cross-repo encryption
2. **Deployment-time vs runtime secrets** — table (Terraform-decrypted vs Lambda-decrypted)
3. **Cold-start decryption pattern** — TypeScript code example (lazy singleton)
4. **Never use env vars for secrets** — bundled `.kms` files only

### 012-api-patterns — New Sections

1. **Sub-resource data belongs on the parent** — inline on GET, expensive ops only on mutation
2. **Branded hostnames over raw provider endpoints** — `{record}.platform.{zone}`
3. **No synthetic UUIDs for naturally unique resources** — use natural keys

### 013-resilience — Full Creation

9 numbered principles as condensed directives (see Data Models section for format).

---

## Deduplication Decisions

| Rule | Placed in | NOT in |
|---|---|---|
| No random generation / property-based testing | `005-conventions` | `006-javascript` |
| Meaningful variability table | `005-conventions` | `006-javascript` |
| The deletion test | `005-conventions` | `006-javascript` |
| `it.each` labelling | `005-conventions` | `006-javascript` |
| Test file per concern | `006-javascript` | `005-conventions` |
| No `setTimeout`/fake timers | `006-javascript` | `005-conventions` |
| Assertions verify observable behaviour | `006-javascript` | `005-conventions` |
| No setup without assertion | `006-javascript` | `005-conventions` |
| Never throw, always err() | `006-javascript` | `005-conventions` |
| No else blocks | `006-javascript` | `005-conventions` |
| Design anti-patterns (1–24) | `005-conventions` | — |
| Resilience principles (1–9) | `013-resilience` | `005-conventions` |
| DynamoDB call optimization | `005-conventions` | `002-aws-terraform` |

---

## Error Handling

- If a SKILL.md exceeds 400 lines after edits, condense further or split into sub-sections
- If `npm run check` fails in the skills directory, halt and report which skill broke
- If frontmatter validation fails (missing `name`/`description`, missing prefix line), fix before committing
- If a rule already exists in the target skill (grep check), skip rather than duplicate

---

## Testing Strategy

No automated tests for this sync. Validation is:

1. **Structural** — after each edit, verify frontmatter is valid YAML with `name` + `description`, prefix line present
2. **Deduplication** — grep each new rule across all skills; zero duplicates
3. **Completeness** — after all tasks, diff every rule in the Strategy diffs against the skills; every rule appears in exactly one skill
4. **Pre-commit gate** — run whatever check script exists in `~/.kiro/skills/` before each commit

---

## Commit Plan

| # | Message | Files |
|---|---|---|
| 1 | `🟣 Sync 005-conventions: design discipline, observability, DI, testing, DynamoDB, git staging` | `005-conventions/SKILL.md` |
| 2 | `🟣 Sync 006-javascript: I-prefix, never throw, no else, testing structure` | `006-javascript/SKILL.md` |
| 3 | `🟣 Sync 002-aws-terraform: deployment boundary, S3 naming, CloudFront, import blocks` | `002-aws-terraform/SKILL.md` |
| 4 | `🟣 Sync 004-secrets: cross-repo encryption, runtime vs deployment, cold-start` | `004-secrets/SKILL.md` |
| 5 | `🟣 Sync 012-api-patterns: sub-resource inlining, branded hostnames, no synthetic UUIDs` | `012-api-patterns/SKILL.md` |
| 6 | `🟣 Create 013-resilience: retry architecture patterns` | `013-resilience/SKILL.md`, `000-skill-management/SKILL.md` |

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| 005-conventions exceeds 400-line limit | Condense design anti-patterns into tighter bullets; move DynamoDB to 012-api-patterns if needed |
| Testing rules already partially in 006-javascript | Grep both skills after edit; remove duplicates from 006-javascript |
| 013-resilience overlaps with design anti-patterns in 005-conventions | Anti-patterns reference resilience by number; full explanation only in 013-resilience |
| Skills repo has no `npm run check` | Verify `package.json`; if absent, validate manually |

---

## Out of Scope

- Automated sync tooling (future consideration)
- Pushing the Strategy repo to origin/main (separate decision)
- Changes to `patterns/caches.md` (no diff in these 33 commits)
