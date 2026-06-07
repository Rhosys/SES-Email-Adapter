# Implementation Plan: Email-Catcher Authorization Checks

## Overview

Migrate authorization from the global JWT middleware into a per-route `authorize(permission)` middleware, add a global `authorizationGuard()` safety net, and create a unit test that verifies all account-scoped routes have the middleware registered. The implementation separates authentication (JWT) from authorization (Authress permission check) and enables per-route permission granularity.

## Tasks

- [x] 1. Create authorization middleware and guard
  - [x] 1.1 Implement `authorize(permission, resourceUri)` middleware
    - Create `src/api/authorization-middleware.ts`
    - Accept `resourceUri` as either a static string or a function `(c: Context) => string` that builds the URI from route params
    - Accept `permission` as a string (e.g., `"arcs:read"`, `"arcs:write"`, `"accounts:read"`)
    - Resolve `resourceUri` from the function/string (e.g., `` c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}` ``)
    - Call `access.checkAccess(userId, resourceUri, permission)` using the existing `AccessService` interface
    - On success: set `c.set("authorizationVerified", true)` and call `next()`
    - On authorization failure (Authress 403): return HTTP 403 with `{ title: "Forbidden", errorCode: "AccessDenied" }` and log warning with userId, resourceUri, permission, path
    - On SDK error: return HTTP 500 with `{ title: "Internal Server Error" }` and log error with full context
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 5.1, 5.2, 5.3, 5.4_

  - [x] 1.2 Implement `authorizationGuard()` global middleware
    - Create `src/api/authorization-guard.ts`
    - Register as `app.use("/accounts/:accountId/*", authorizationGuard())`
    - After route handler runs, check `c.get("authorizationVerified")`
    - If flag is not set, return HTTP 403 — safety net for forgotten `authorize()` calls
    - _Requirements: 3.1, 2.1_

  - [x] 1.3 Write property tests for authorization middleware
    - **Property 1: Authorization middleware extracts account ID from path**
    - **Property 2: Authorization middleware enforces permission level**
    - **Property 3: Authorization short-circuits on failure**
    - **Property 4: Authorization failure returns 403 with error code**
    - **Property 5: Authress SDK failure returns 500 with logged error**
    - **Property 6: Authorization failures are logged**
    - **Property 7: Error responses sanitize internal details**
    - **Validates: Requirements 1.2, 1.3, 1.4, 2.2, 2.3, 2.4, 5.1, 5.2, 5.3, 5.4**

  - [x] 1.4 Write property tests for authorization guard
    - **Property 8: Authorization guard blocks unprotected routes**
    - **Property 9: Authorization guard passes when middleware ran**
    - **Validates: Requirements 3.1, 6.1**

- [x] 2. Checkpoint - Verify middleware and guard work in isolation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Migrate routes to use per-route authorization
  - [x] 3.1 Remove authorization logic from JWT middleware
    - In `src/api/app.ts`, remove the `access.checkAccess()` call and `accountMatch` regex from the JWT `app.use("*")` middleware
    - JWT middleware should only authenticate (verify token, set `auth` context with userId)
    - The `auth` context should set `accountId` from the URL path without verifying access
    - _Requirements: 6.1, 6.2, 6.3_

 - [x] 3.2 Register `authorizationGuard()` globally and add `authorize(permission, resourceUri)` to all account-scoped routes
    - Register `authorizationGuard()` as `app.use("/accounts/:accountId/*", authorizationGuard())`
    - Add `authorize(c => \`accounts/${c.req.param("accountId")}/...\`, permission)` to each route with the appropriate resource path and permission
    - Use `"...:read"` for GET routes and `"...:write"` for POST/PATCH/DELETE routes
    - Wire the `access` dependency into the middleware (pass via closure or Hono env)
    - _Requirements: 1.1, 1.3, 2.1, 2.2, 2.3, 6.1, 6.2, 6.3, 6.4_

  - [x] 3.3 Write unit tests for route migration
    - Verify authorized users still get 200 responses (backward compatibility)
    - Verify unauthorized users get 403 from the new middleware
    - Verify existing test suite passes without modification
    - _Requirements: 6.1, 6.2, 6.4_

- [x] 4. Checkpoint - Verify migration is complete and backward-compatible
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Add authorization coverage unit test
  - [x] 5.1 Implement middleware registration inspection test
    - Create `src/api/authorization-coverage.spec.ts`
    - Instantiate the app via `createApp()` with mock dependencies
    - Iterate over Hono's `app.routes` to find all routes with `:accountId` in the path
    - Verify each account-scoped route has the `authorize` middleware in its handler chain
    - Maintain an explicit allowlist for exempted routes (health check, OpenAPI spec, OPTIONS)
    - Fail with descriptive error listing any missing routes
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 5.2 Write unit tests for edge cases
    - Test that routes without `:accountId` (e.g., `GET /`, `GET /healthcheck`) are not flagged
    - Test that the test itself fails when a route is missing authorization (negative test)
    - _Requirements: 3.4_

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The existing `AccessService.checkAccess()` interface is unchanged — the middleware just calls it in a new location
- The migration (task 3) is the critical path: it moves authorization out of JWT middleware into per-route middleware while maintaining identical behavior for authorized users

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2"] },
    { "id": 4, "tasks": ["3.3", "5.1"] },
    { "id": 5, "tasks": ["5.2"] }
  ]
}
```
