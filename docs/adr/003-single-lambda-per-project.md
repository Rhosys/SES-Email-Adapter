# ADR 003: Single Lambda Per Project

## Context

AWS Lambda makes it trivially easy to create new functions for each feature — a scheduled job here, an API handler there, an SQS consumer over there. This leads to deployment sprawl: dozens of functions with independent configurations, IAM roles, memory settings, cold start profiles, and deployment pipelines. Each new function is another thing to monitor, another thing that can drift, another thing that needs its own CloudWatch alarms.

## Decision

One Lambda function per project. All entry points — API routes, SQS consumers, EventBridge scheduled jobs — are handlers exported from the same codebase and deployed as a single artifact. Routing happens at the event source level (API Gateway path mapping, EventBridge rule targets, SQS trigger configuration), not at the Lambda level.

## Consequences

- New features add handlers to the existing function, not new functions
- Scheduled jobs (like the weekly domain health check) share the same Lambda; new weekly tasks are added to the existing handler rather than creating parallel functions
- Cold start cost is paid once across all entry points
- A single IAM role covers all permissions (principle of least privilege is enforced at the application layer, not the function boundary)
- Deployment is atomic — all handlers update together, no version skew between functions
- Memory/timeout configuration must accommodate the most demanding handler (the weekly batch job at 15 min timeout)

## Alternatives Considered

- **One Lambda per handler**: Maximum isolation but unmanageable at scale. Rejected.
- **Lambda per event source type** (one for API, one for SQS, one for scheduled): Moderate isolation but still creates deployment sprawl and version skew. Rejected.
