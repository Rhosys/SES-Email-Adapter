# Requirements Document

## Introduction

Propagate changes from the `_Strategy/` directory into the corresponding Kiro skill `SKILL.md` files at `~/.kiro/skills/`. The Strategy repo is the authoritative source for conventions and patterns; the skills are the user-facing, condensed versions consumed by Kiro. When Strategy files change, the corresponding skills must be updated to reflect the new or modified content while preserving the skill format (frontmatter, prefix instruction, concise actionable rules).

## Glossary

- **Strategy_Repo**: The git repository at `/home/warren/git/claude/_Strategy/` containing authoritative convention and pattern documents
- **Skills_Directory**: The directory at `~/.kiro/skills/` (symlinked to `~/git/claude/_skills`) containing Kiro skill definitions
- **SKILL_File**: A `SKILL.md` file within a numbered skill directory that defines the skill's content, frontmatter, and activation prefix
- **Mapping**: The association between a Strategy file path and its corresponding skill number and directory
- **Diff_Delta**: The set of added, modified, or removed lines in a Strategy file relative to the last synced state
- **Sync_Operation**: The process of reading a Strategy file's changes and applying equivalent updates to the corresponding SKILL_File

## Requirements

### Requirement 1: Strategy-to-Skill Mapping Resolution

**User Story:** As a developer, I want each Strategy file to map to a known skill, so that changes propagate to the correct SKILL.md file.

#### Acceptance Criteria

1. THE Sync_Operation SHALL resolve each changed Strategy file to its corresponding skill using the following mapping:
   - `conventions.md` → `005-conventions`
   - `languages/javascript.md` → `006-javascript`
   - `languages/terraform.md` → `002-aws-terraform`
   - `patterns/api.md` → `012-api-patterns`
   - `secrets.md` → `004-secrets`
   - `languages/kotlin-compose.md` → `007-kotlin-compose`
   - `languages/react-native-expo.md` → `008-mobile-expo`
   - `languages/rust.md` → `009-rust`
   - `android-permissions.md` → `010-android-perms`
   - `llm-discoverability.md` → `011-llm-discoverability`
   - `risk-model.md` → `003-risk-model`
   - `AUTHOR.md` → `001-writing-voice`
2. WHEN a changed Strategy file path does not match any key in the mapping table, THEN THE Sync_Operation SHALL skip that file and emit a log entry at WARN level containing the unmatched file path
3. WHEN a Strategy file maps to multiple skills, THE Sync_Operation SHALL update each mapped skill independently, such that a failure to update one skill does not prevent updates to the remaining mapped skills
4. IF a mapped skill file does not exist at the target path, THEN THE Sync_Operation SHALL create the skill file before writing content to it

### Requirement 2: Diff Extraction from Strategy Repo

**User Story:** As a developer, I want to identify exactly what changed in each Strategy file, so that only new or modified content is synced to skills.

#### Acceptance Criteria

1. THE Sync_Operation SHALL extract the diff for each changed Strategy file by comparing the current HEAD against `origin/main`, producing a set of added lines and removed lines for each file
2. WHEN a Strategy file is newly created (not present in `origin/main`), THE Sync_Operation SHALL treat the entire file content as added lines and categorize the file as `new_file`
3. THE Sync_Operation SHALL categorize each changed file as exactly one of: `new_file` (file exists in HEAD but not in `origin/main`), `content_modified` (file exists in both but has added or removed lines), or `file_deleted` (file exists in `origin/main` but not in HEAD)
4. WHEN a Strategy file is renamed (same content, different path), THE Sync_Operation SHALL treat it as a deletion of the old path and a `new_file` at the new path
5. WHEN a Strategy file is deleted (present in `origin/main` but absent from HEAD), THE Sync_Operation SHALL categorize it as `file_deleted` and produce the full prior content as removed lines

### Requirement 3: Skill Content Update for Existing Skills

**User Story:** As a developer, I want Strategy changes applied to the corresponding SKILL.md while preserving the skill format, so that skills stay in sync without breaking their structure.

#### Acceptance Criteria

1. THE Sync_Operation SHALL preserve the SKILL_File frontmatter block (YAML between `---` delimiters) unchanged
2. THE Sync_Operation SHALL preserve the SKILL_File header block (H1 title line and prefix instruction line) unchanged
3. WHEN a new section is added to a Strategy file, THE Sync_Operation SHALL append a corresponding section to the SKILL_File body using the Strategy section heading as the SKILL section heading
4. WHEN an existing section is modified in a Strategy file, THE Sync_Operation SHALL update the section in the SKILL_File that shares the same heading to reflect the new wording
5. WHEN a section is removed from a Strategy file, THE Sync_Operation SHALL remove the section in the SKILL_File that shares the same heading
6. THE Sync_Operation SHALL condense Strategy content into imperative, directive-style rules (single-sentence bullets or short tables) omitting explanatory prose and "Why:" blocks unless the rationale is required to apply the rule correctly
7. IF a Strategy section has no matching heading in the SKILL_File, THEN THE Sync_Operation SHALL treat it as a new section and append it to the end of the SKILL_File body

### Requirement 4: New Skill Creation

**User Story:** As a developer, I want new Strategy files that have no existing skill to result in a new skill directory and SKILL.md, so that all Strategy content is represented in the skill system.

#### Acceptance Criteria

1. WHEN a Strategy file has no existing skill mapping, THE Sync_Operation SHALL create a new skill directory at the Skills_Directory using the next sequential 3-digit number prefix and a kebab-case slug derived from the Strategy filename without extension (e.g. `patterns/resilience.md` → `013-resilience`, `aws-terraform.md` → `013-aws-terraform`)
2. THE Sync_Operation SHALL generate a SKILL_File with YAML frontmatter where `name` matches the directory name (e.g. `013-resilience`) and `description` is a single sentence (maximum 200 characters) summarising the skill's scope derived from the Strategy file's first heading or opening paragraph
3. THE Sync_Operation SHALL include the H1 title in format `# NNN-CODE — Human-Readable Name` followed by the prefix instruction line `**Prefix every response where this skill is active with \`NNN-CODE\`.**` where CODE is the uppercase slug truncated to a maximum of 6 characters (e.g. `resilience` → `RESIL`, `aws-terraform` → `AWS`)
4. THE Sync_Operation SHALL populate the SKILL_File body with condensed rules derived from the Strategy file content following the transformation rules defined in Requirement 5
5. IF the derived directory slug conflicts with an existing skill directory name, THEN THE Sync_Operation SHALL report the conflict and halt without creating the directory

### Requirement 5: Content Transformation Rules

**User Story:** As a developer, I want consistent transformation from verbose Strategy prose to concise skill directives, so that skills remain compact and actionable.

#### Acceptance Criteria

1. THE Sync_Operation SHALL remove "Why:" explanation blocks and multi-sentence justifications from Strategy content
2. IF a "Why:" block contains a condition, threshold, or constraint that a reader needs in order to apply the rule correctly, THEN THE Sync_Operation SHALL inline that condition into the directive itself rather than removing it
3. THE Sync_Operation SHALL convert multi-paragraph explanations into single-line directives or bullet lists of no more than 5 items per rule
4. WHEN a Strategy file contains a fenced code block (delimited by triple backticks), THE Sync_Operation SHALL preserve the code block verbatim in the SKILL_File
5. WHEN a Strategy file contains a markdown table, THE Sync_Operation SHALL preserve the table verbatim in the SKILL_File
6. THE Sync_Operation SHALL retain markdown section headers (lines starting with `#`, `##`, or `###`) that group rules by topic
7. THE Sync_Operation SHALL not produce a SKILL_File body exceeding 400 lines (excluding frontmatter and prefix instruction)

### Requirement 6: Files Excluded from Sync

**User Story:** As a developer, I want certain Strategy files excluded from skill sync, so that workspace-level or meta files do not pollute the skill system.

#### Acceptance Criteria

1. THE Sync_Operation SHALL skip `CLAUDE.md` (workspace-level authority file, not a skill)
2. THE Sync_Operation SHALL skip any file in `_Strategy/.git/` and any dotfile or dot-directory (files or directories whose name starts with `.`) within `_Strategy/`
3. IF a Strategy file change produces identical content after normalizing all whitespace (collapsing consecutive blank lines to one, trimming trailing whitespace from lines, and removing trailing newlines), THEN THE Sync_Operation SHALL skip the update
4. THE Sync_Operation SHALL only process files with the `.md` extension; non-markdown files SHALL be skipped without error

### Requirement 7: Validation After Sync

**User Story:** As a developer, I want the sync to validate that updated skills are structurally correct, so that broken skills are caught before commit.

#### Acceptance Criteria

1. WHEN a SKILL_File is updated, THE Sync_Operation SHALL verify the frontmatter is parseable YAML between `---` delimiters containing a `name` field that matches the skill directory name (e.g. `005-conventions`) and a `description` field that is a non-empty string of at most 200 characters
2. WHEN a SKILL_File is updated, THE Sync_Operation SHALL verify the prefix instruction line is present and contains the skill's short code in the format `NNN-XXXX` where NNN matches the skill's numeric prefix
3. IF a SKILL_File fails validation after update, THEN THE Sync_Operation SHALL output the skill directory name and the specific validation failure to stderr, and halt the entire sync batch without committing any skills
4. IF the SKILL_File frontmatter block is missing or not parseable as YAML, THEN THE Sync_Operation SHALL treat this as a validation failure

### Requirement 8: Commit Discipline

**User Story:** As a developer, I want each skill update committed individually with a clear message, so that the git history shows which strategy change drove each skill update.

#### Acceptance Criteria

1. THE Sync_Operation SHALL stage only the modified SKILL_File for each commit (using explicit file paths, never `git add .`)
2. THE Sync_Operation SHALL use the commit message format `🟣 Sync {skill-name}: {summary of what changed}` where the total subject line does not exceed 72 characters
3. WHEN multiple Strategy files map to the same skill, THE Sync_Operation SHALL combine their changes into a single commit for that skill
4. THE Sync_Operation SHALL run `npm run check` in the skills project directory before committing each skill and halt the entire sync operation if it fails, leaving already-committed skills in place
5. IF `npm run check` fails, THEN THE Sync_Operation SHALL report which skill failed validation and exit with a non-zero status without committing the failing skill or any remaining skills

### Requirement 9: Handling the patterns/testing.md Split Decision

**User Story:** As a developer, I want the testing patterns file handled correctly whether it maps to an existing skill or needs a new one, so that testing rules land in the right place.

#### Acceptance Criteria

1. WHEN a rule in `patterns/testing.md` addresses a topic already covered in the `006-javascript` Testing section (test runner choice, co-location convention, Arrange-Act-Assert, mocking boundary, coverage targets), THE Sync_Operation SHALL merge the `patterns/testing.md` content into the existing `006-javascript` Testing section rather than creating a duplicate entry
2. WHEN a rule in `patterns/testing.md` makes no reference to a specific language, runtime, or framework (e.g. meaningful variability, no random generation, deletion test, `it.each` labelling), THE Sync_Operation SHALL place it in a new `## Testing` section within `005-conventions`
3. IF a rule is language-agnostic but `006-javascript` already contains a version of it, THEN THE Sync_Operation SHALL keep the rule only in `005-conventions` and remove the overlapping text from `006-javascript` to avoid duplication
4. THE Sync_Operation SHALL not produce the same rule (same observable constraint, regardless of wording) in more than one skill file
5. WHEN the split is complete, THE Sync_Operation SHALL verify that every rule present in `patterns/testing.md` appears in exactly one skill file (`005-conventions` or `006-javascript`)

### Requirement 10: Patterns with Dedicated Caching Content

**User Story:** As a developer, I want the `patterns/caches.md` content included in the api-patterns skill alongside the API rules, so that cache architecture guidance is co-located with API design.

#### Acceptance Criteria

1. THE Sync_Operation SHALL include content from both `patterns/api.md` and `patterns/caches.md` in the `012-api-patterns` SKILL_File
2. WHEN `patterns/caches.md` changes, THE Sync_Operation SHALL regenerate the cache-related sections in the `012-api-patterns` SKILL_File without modifying sections sourced from `patterns/api.md`
3. THE Sync_Operation SHALL place the cache-related sections after the API response rules sections within the `012-api-patterns` SKILL_File
4. WHEN `patterns/api.md` changes, THE Sync_Operation SHALL regenerate the API response rules sections in the `012-api-patterns` SKILL_File without modifying sections sourced from `patterns/caches.md`
