# Claude Instructions

## Todos
Always track todos in `TODO.md` at the repo root. When adding, completing, or removing tasks, update `TODO.md` directly — do not rely solely on in-memory TodoWrite. TodoWrite may be used alongside it, but `TODO.md` is the source of truth.

## Behaviour
- GitHub Actions step summaries render ANSI color codes. Do not strip color from CLI tool output destined for `$GITHUB_STEP_SUMMARY`.
