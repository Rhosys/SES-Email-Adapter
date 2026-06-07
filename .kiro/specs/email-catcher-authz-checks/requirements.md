# Requirements Document: Email-Catcher Authorization Checks

## Introduction

This feature adds authorization checks to all backend API routes in the email-catcher service. Every API endpoint must verify that the authenticated user has appropriate access to the requested account before processing the request. The system should use the Authress SDK's authorization check endpoint to validate access, and include a unit test that dynamically validates every endpoint has an authorization check implemented.

## Glossary

- **API Route**: An HTTP endpoint defined in the Hono application (e.g., `GET /accounts/:accountId/arcs`)
- **Authress SDK**: The authorization service SDK used to verify user permissions
- **Authorization Check**: A call to `AuthressClient.userPermissions.authorizeUser()` or `listResources()` to verify access
- **Account ID**: The unique identifier for an email-catcher account, extracted from the URL path
- **Authenticated User**: The user whose identity has been verified via JWT token

## Requirements

### Requirement 1: Authorization Check on All Account-Scoped Routes

**User Story:** As a developer, I want every API route that accesses account data to verify user authorization, so that users can only access their own accounts and data.

#### Acceptance Criteria

1. WHEN an API route includes an `:accountId` path parameter, THE API Server SHALL call `AuthressClient.userPermissions.authorizeUser()` or `AuthressClient.accessRecords.listResources()` before processing the request
2. WHERE the authorization check fails, THE API Server SHALL return HTTP 403 Forbidden with an appropriate error message
3. WHILE processing any request, THE API Server SHALL NOT execute route handler logic until authorization is verified
4. IF the Authress SDK call fails, THEN THE API Server SHALL return HTTP 500 Internal Server Error with error details logged

### Requirement 2: Authorization Check Implementation Pattern

**User Story:** As a developer, I want a consistent pattern for implementing authorization checks, so that all routes are protected uniformly and new routes are less likely to miss authorization.

#### Acceptance Criteria

1. WHEN a new API route is added with an `:accountId` path parameter, THE Implementation Pattern SHALL provide a reusable middleware or decorator that applies authorization checking
2. THE Authorization Middleware SHALL extract the `accountId` from the URL path and verify the authenticated user has `account:read` permission
3. WHERE a route requires a different permission level (e.g., `account:write`), THE Implementation Pattern SHALL support configurable permission requirements
4. THE Authorization Middleware SHALL short-circuit request processing and return 403 if authorization fails

### Requirement 3: Unit Test for Authorization Coverage

**User Story:** As a developer, I want a unit test that dynamically validates every endpoint has an authorization check, so that new routes cannot be added without authorization by accident.

#### Acceptance Criteria

1. WHEN the test suite runs, THE Test Suite SHALL scan all API route definitions and verify each route with `:accountId` has an authorization check
2. THE Test Suite SHALL use AST parsing or runtime inspection to detect calls to `AuthressClient.userPermissions.authorizeUser()` or `AuthressClient.accessRecords.listResources()`
3. WHERE a route with `:accountId` lacks an authorization check, THE Test Suite SHALL fail with a descriptive error listing the missing routes
4. FOR ALL routes, THE Test Suite SHALL distinguish between routes that require authorization (account-scoped) and routes that do not (e.g., health checks, open endpoints)

### Requirement 4: Authorization Check for List Resources Endpoint

**User Story:** As a developer, I want to use the Authress list resources endpoint as an alternative to user permissions authorization, so that we have flexibility in how we implement authorization checks.

#### Acceptance Criteria

1. WHEN the authorization check is implemented using `listResources()`, THE API Server SHALL verify the authenticated user has access to resources matching the account pattern `accounts/${accountId}`
2. WHERE `listResources()` is used instead of `authorizeUser()`, THE Implementation SHALL provide equivalent security guarantees
3. THE Authorization Check SHALL validate that the user has at least `account:read` permission on the target account

### Requirement 5: Error Handling and Logging

**User Story:** As a developer, I want authorization failures to be logged and distinguishable from other errors, so that security incidents can be detected and debugged.

#### Acceptance Criteria

1. WHEN an authorization check fails, THE System SHALL log the failure with user ID, account ID, and timestamp
2. WHEN an Authress SDK call fails, THE System SHALL log the error with full stack trace and request context
3. THE Error Response SHALL not expose internal implementation details (e.g., Authress API URLs, service names)
4. WHERE authorization fails due to missing permissions, THE Response SHALL include a machine-readable error code (e.g., `AUTHORIZATION_FAILED`)

### Requirement 6: Backward Compatibility with Existing Routes

**User Story:** As a developer, I want existing routes to be updated to include authorization checks without breaking changes, so that the migration is safe and incremental.

#### Acceptance Criteria

1. WHEN existing routes are updated to include authorization checks, THE Behavior SHALL remain identical for authorized users
2. WHERE a route previously returned 403 for unauthorized access, THE Updated Route SHALL maintain the same response status and message
3. THE Authorization Check SHALL be added as a pre-handler middleware that does not modify the route handler signature
4. FOR All existing tests, THE Updated Routes SHALL pass without modification if the user was previously authorized
