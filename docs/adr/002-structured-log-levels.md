# ADR 002: Structured Log Levels

## Context

The backend needs a consistent log level taxonomy that maps directly to alerting behaviour. Standard log levels (debug/info/warn/error) don't distinguish between "something to review daily" and "something that needs immediate attention." We need levels that encode operational response expectations.

## Decision

Six log levels, each with defined alerting semantics:

| Level | Purpose | Alert Behaviour |
|-------|---------|-----------------|
| `DEBUG` | Development-only diagnostic output | Never alerted |
| `INFO` | Operational lifecycle events (job started, job completed, deploy) | Never alerted |
| `TRACK` | Metrics and signals that warrant daily review (staleness reports, usage patterns, threshold breaches) | Batched notification every 24 hours |
| `WARN` | Degraded behaviour that may indicate a problem at scale | Alerted when volume exceeds a configured percentage threshold |
| `ERROR` | Something broke for a specific request/operation | Reported immediately; high volume indicates an incident |
| `CRITICAL` | System-wide failure, data loss risk, or security breach | Triggers incident immediately |

## Log Entry Format

All structured logs are JSON with at minimum:

```json
{
  "level": "track",
  "message": "staleness_checker.outstanding_arcs",
  "timestamp": "2025-05-11T16:00:00.000Z",
  ...domain-specific fields
}
```

The `level` field drives routing in the logging infrastructure. The `message` field is a dot-separated identifier (not a human sentence) used for filtering and grouping.

## Consequences

- All `console.warn` calls in the codebase should be reviewed — some are actually TRACK or ERROR level
- The logging infrastructure (already deployed) routes based on the `level` field in structured JSON
- New code should use the appropriate level based on the alerting behaviour it expects, not the severity it "feels like"
