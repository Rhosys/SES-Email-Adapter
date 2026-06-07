# Design Document: Email-Catcher Authorization Checks

## Overview

This feature adds authorization checks to all backend API routes in the email-catcher service. Every API endpoint that accesses account data must verify that the authenticated user has appropriate access to the requested account before processing the request.

The implementation uses a **middleware pattern** for Hono routes, with a **runtime inspection test** that dynamically validates every endpoint has an authorization check implemented. The system uses the Authress SDK's `authorizeUser()` and `listResources()` methods for authorization verification.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Hono Application                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  JWT Verification Middleware (existing)                                │ │
│  │  - Extracts userId from JWT token                                      │ │
│  │  - Sets auth context on request                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                              │                                               │
│                              ▼                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  Authorization Middleware (NEW)                                        │ │
│  │  - Extracts accountId from URL path                                    │ │
│  │  - Calls Authress SDK for authorization                                │ │
│  │  - Short-circuits with 403 if unauthorized                             │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                              │                                               │
│                              ▼                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  Route Handlers (existing, unchanged)                                  │ │
│  │  - Process authorized requests                                         │ │
│  │  - Access account data via store                                       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Authorization Test Suite (NEW)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  - Scans all route definitions                                             │
│  - Detects :accountId parameters                                           │
│  - Verifies authorization check is present                                 │
│  - Reports missing authorizations                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces
### Current State

Authorization is currently embedded inside the global JWT verification middleware (`app.use("*")`). It extracts `accountId` from the URL path and calls `access.checkAccess(userId, accountId, "account:read")`. This works but has several problems:

1. It's coupled to the JWT middleware — authorization logic shouldn't live there
2. It hard-codes `"account:read"` for all routes — no way to require `"account:write"` for mutations
3. The global middleware has no knowledge of the specific resource or permission that should be checked for each route — it cannot construct a meaningful `resourceUri` or select the correct permission because it operates before route matching
4. If someone adds a new route group that doesn't match the regex, there's no safety net

### New Components

#### 1. Authorization Middleware (per-route)

```typescript
// src/api/authorization-middleware.ts

/**
 * Mirrors the Authress SDK interface: authorizeUser(userId, resourceUri, permission)
 * The middleware extracts userId from auth context.
 * The caller specifies the permission and a resourceUri — either as a static string
 * or as a function that receives the Hono Context and dynamically constructs the URI
 * from route params (e.g., `c => \`accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}\``).
 */
export function authorize(resourceUri: string | ((c: Context) => string), permission: string): MiddlewareHandler;
```

**Behavior:**
- Resolves `resourceUri` — either a static string or a function that builds it from route params (e.g., `` c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}` ``)
- Calls `access.checkAccess(userId, resourceUri, permission)` — which internally calls `AuthressClient.userPermissions.authorizeUser(userId, resourceUri, permission)`
- On success: sets a context flag `c.set("authorizationVerified", true)` and calls `next()`
- On failure: returns HTTP 403
- On SDK error: returns HTTP 500, logs error with userId, resourceUri, permission, path

**Usage:**
```typescript
// List arcs — resource is the arcs collection under the account
app.get("/accounts/:accountId/arcs",
  authorize("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs`),
  handler
);

// Update a specific arc — resource includes the arc ID
app.patch("/accounts/:accountId/arcs/:id",
  authorize("arcs:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}`),
  handler
);

// Account-level operations
app.get("/accounts/:accountId",
  authorize("accounts:read", c => `accounts/${c.req.param("accountId")}`),
  handler
);

// List all accounts the user has access to — uses listResources, no accountId in path
app.get("/accounts",
  authorize("accounts:read", "accounts"),
  handler
);

// Reindex — cross-account management operation, not scoped to a single account
app.post("/reindex",
  authorize("management:write", "reindex"),
  handler
);

// Account maintenance routes
app.patch("/accounts/:accountId",
  authorize("accounts:write", c => `accounts/${c.req.param("accountId")}`),
  handler
);

app.delete("/accounts/:accountId",
  authorize("accounts:write", c => `accounts/${c.req.param("accountId")}`),
  handler
);

app.post("/accounts/:accountId/verify-domain",
  authorize("accounts:write", c => `accounts/${c.req.param("accountId")}`),
  handler
);

// User management routes (admin managing users within an account)
app.get("/accounts/:accountId/users",
  authorize("users:read", c => `accounts/${c.req.param("accountId")}/users`),
  handler
);

app.post("/accounts/:accountId/users",
  authorize("users:write", c => `accounts/${c.req.param("accountId")}/users`),
  handler
);

app.get("/accounts/:accountId/users/:userId",
  authorize("users:read", c => `accounts/${c.req.param("accountId")}/users/${c.req.param("userId")}`),
  handler
);

app.put("/accounts/:accountId/users/:userId",
  authorize("users:write", c => `accounts/${c.req.param("accountId")}/users/${c.req.param("userId")}`),
  handler
);

app.delete("/accounts/:accountId/users/:userId",
  authorize("users:write", c => `accounts/${c.req.param("accountId")}/users/${c.req.param("userId")}`),
  handler
);

// User profile routes (user accessing their own profile by userId, no accountId)
app.get("/users/:userId",
  authorize("users:read", c => `users/${c.req.param("userId")}`),
  handler
);

app.patch("/users/:userId",
  authorize("users:write", c => `users/${c.req.param("userId")}`),
  handler
);
```

#### 2. Authorization Guard (global catch-all)

```typescript
// src/api/authorization-guard.ts

/**
 * Global middleware that runs AFTER route handlers.
 * For any route with :accountId, verifies that the authorization middleware
 * was executed (by checking the context flag). If not, returns 403.
 *
 * This is the safety net — if someone forgets to add authorize() to a route,
 * the guard catches it at runtime.
 */
export function authorizationGuard(): MiddlewareHandler;
```

**Behavior:**
- Runs as a global `app.use("*")` middleware registered BEFORE route handlers
- Registers an `after` hook that checks `c.get("authorizationVerified")` after the route handler runs
- If the flag is not set, returns 403 — this applies to ALL routes, not just those with `:accountId`
- Explicit exceptions are maintained in an allowlist:
  - `GET /healthcheck` — health check endpoint
  - `OPTIONS *` — CORS preflight requests
  - `GET /` — OpenAPI specification
- Any route not in the allowlist that completes without the `authorizationVerified` flag being set will be blocked with 403

**Why this works:** Even if a developer forgets to add `authorize()` to a new route, the guard will block the request at runtime. The unit test catches it at build time; the guard catches it in production. By defaulting to deny-all rather than only checking `:accountId` routes, any new route — regardless of its path structure — is automatically protected until explicitly exempted or given an authorization middleware.
#### 3. Authorization Coverage Unit Test

```typescript
// src/api/authorization-coverage.spec.ts

/**
 * Inspects the Hono app's middleware stack for each route.
 * Verifies that every route (except explicitly exempted ones) has the authorize() middleware registered.
 * No AST parsing needed — just checks the middleware registration.
 *
 * Explicit exemptions:
 * - GET /healthcheck
 * - OPTIONS * (all OPTIONS requests)
 * - GET / (OpenAPI specification)
 */
```

### Modified Components

#### 1. AccessService interface (existing — signature updated)

```typescript
export interface AccessService {
  checkAccess(userId: string, resourceUri: string, permission: string): Promise<void>;
}
```

The `authorize()` middleware calls `access.checkAccess()` with the full `resourceUri` (e.g., `accounts/acc-123/arcs/arc-456`). Internally this calls `AuthressClient.userPermissions.authorizeUser(userId, resourceUri, permission)`.

## Data Models

### Context Flag

The authorization middleware sets a simple boolean flag on the Hono context to signal that authorization was verified:

```typescript
// Set by authorize() middleware
c.set("authorizationVerified", true);

// Checked by authorizationGuard()
const verified = c.get("authorizationVerified");
```

### Error Response Format

**403 Forbidden (Unauthorized):**
```json
{
  "title": "Forbidden",
  "errorCode": "AccessDenied"
}
```

**500 Internal Server Error (Service Failure):**
```json
{
  "title": "Internal Server Error"
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Authorization middleware extracts account ID from path

*For any* HTTP request with an `:accountId` path parameter, the authorization middleware SHALL correctly extract the account ID value from the URL path and construct the `resourceUri` as `accounts/${accountId}` for authorization verification.

**Validates: Requirements 2.2**

### Property 2: Authorization middleware enforces permission level

*For any* route with configurable permission requirements, the authorization middleware SHALL use the specified permission level (e.g., `account:read`, `account:write`) when calling the Authress SDK, and SHALL reject requests that lack the required permission.

**Validates: Requirements 2.3**

### Property 3: Authorization short-circuits on failure

*For any* request where authorization fails, the authorization middleware SHALL short-circuit request processing and return HTTP 403 Forbidden without executing the route handler logic.

**Validates: Requirements 1.3, 2.4**

### Property 4: Authorization failure returns 403 with error code

*For any* request where the user lacks authorization, the system SHALL return HTTP 403 Forbidden with a machine-readable error code `AUTHORIZATION_FAILED` in the response body.

**Validates: Requirements 1.2, 5.4**

### Property 5: Authress SDK failure returns 500 with logged error

*For any* request where the Authress SDK call fails, the system SHALL return HTTP 500 Internal Server Error, log the full error with stack trace and request context, and include error details in the response.

**Validates: Requirements 1.4, 5.2**

### Property 6: Authorization failures are logged

*For any* authorization failure, the system SHALL log the failure with user ID, resource URI, and timestamp in a structured format.

**Validates: Requirements 5.1**

### Property 7: Error responses sanitize internal details

*For any* error response, the system SHALL NOT expose internal implementation details such as Authress API URLs, service names, or stack traces in the response body.

**Validates: Requirements 5.3**

### Property 8: Authorization guard blocks unprotected routes

*For any* route with `:accountId` where the `authorize()` middleware was NOT registered, the global authorization guard SHALL return HTTP 403 Forbidden, preventing access to unprotected account-scoped routes.

**Validates: Requirements 3.1**

### Property 9: Authorization guard passes when middleware ran

*For any* route where the `authorize()` middleware successfully ran and set the context flag, the authorization guard SHALL allow the response to pass through unchanged.

**Validates: Requirements 6.1**

## Error Handling

### Authorization Failure Flow

```
Request → JWT Verification → Authorization Middleware
                                      │
                                      ├─ Success → Route Handler
                                      │
                                      ├─ Authress SDK returns 403 → Return 403 with errorCode: "AUTHORIZATION_FAILED"
                                      │
                                      └─ Authress SDK throws error → Log error, Return 500 with errorCode: "AUTHORIZATION_SERVICE_ERROR"
```

### Error Response Format

**403 Forbidden (Unauthorized):**
```json
{
  "title": "AccessDenied. User does not have sufficient access to Do X on Y with permissions Z.",
  "errorCode": "AccessDenied"
}
```

**500 Internal Server Error (Service Failure):**
```json
{
  "title": "Internal Server Error"
}
```

### Logging Format

**Authorization Failure:**
```json
{
  "level": "warn",
  "message": "Authorization failed",
  "timestamp": "2024-01-15T10:00:00Z",
  "userId": "user-123",
  "resourceUri": "accounts/account-456",
  "permission": "account:read",
  "path": "/accounts/account-456/arcs"
}
```

**SDK Error:**
```json
{
  "level": "error",
  "message": "Authress SDK call failed",
  "timestamp": "2024-01-15T10:00:00Z",
  "userId": "user-123",
  "resourceUri": "accounts/account-456",
  "permission": "account:read",
  "path": "/accounts/account-456/arcs",
  "error": {
    "message": "Unauthorized",
    "stack": "..."
  }
}
```

## Testing Strategy

### Dual Testing Approach

**Unit Tests:**
- Verify specific examples and edge cases
- Test error handling scenarios
- Test middleware behavior with mocked Authress SDK

**Property Tests:**
- Verify universal properties across all inputs
- Test authorization extraction from various path formats
- Test permission enforcement with different permission levels

### Property-Based Testing Configuration

- **Library:** fast-check (already in project dependencies)
- **Minimum iterations:** 100 per property test
- **Tag format:** `Feature: email-catcher-authz-checks, Property {number}: {property_text}`

### Test Coverage

| Test Type | Coverage | Example |
|-----------|----------|---------|
| Property | Authorization middleware extracts account ID from various path formats | `Property 1` |
| Property | Authorization middleware enforces configurable permission levels | `Property 2` |
| Property | Authorization short-circuits on failure | `Property 3` |
| Property | Authorization failure returns 403 with error code | `Property 4` |
| Property | Authress SDK failure returns 500 with logged error | `Property 5` |
| Property | Authorization failures are logged with required fields | `Property 6` |
| Property | Error responses sanitize internal details | `Property 7` |
| Property | Authorization guard blocks unprotected routes | `Property 8` |
| Property | Authorization guard passes when middleware ran | `Property 9` |
| Unit | All account-scoped routes have authorize() middleware registered | Requirements 3.1-3.4 |
| Unit | Middleware integration with existing routes | Requirements 2.1, 2.4 |

### Authorization Coverage Test

The test suite will include a **middleware registration inspection test** that:

1. **Instantiates the app** via `createApp()` with mock dependencies
2. **Iterates over Hono's route definitions** to find all routes with `:accountId`
3. **Checks the middleware stack** for each route to verify `authorize()` is present
4. **Reports missing routes** with descriptive error messages

**Test Implementation:**

```typescript
describe("Authorization Coverage", () => {
  it("all account-scoped routes have authorize() middleware", () => {
    const app = createApp({ store, auth, access });
    const routes = app.routes; // Hono exposes registered routes
    
    const accountRoutes = routes.filter(r => r.path.includes(":accountId"));
    const missing = accountRoutes.filter(r => 
      !r.middleware.some(m => m.name === "authorize")
    );
    
    expect(missing).toHaveLength(0);
  });
});
```

**Why this works:**
- No AST parsing — just inspects the middleware registration
- Catches missing authorization at test time, before code reaches production
- Combined with the global guard, provides defense in depth

## Implementation Notes

### Migration from Current State

The current code has authorization baked into the JWT middleware. The migration:

1. **Extract authorization into `authorize()` middleware** — separate concern from JWT verification
2. **Add `authorize(permission)` to each route** — explicit per-route permission
3. **Add global `authorizationGuard()`** — safety net for forgotten middleware
4. **Remove authorization logic from JWT middleware** — JWT only does authentication
5. **Add coverage unit test** — verifies middleware registration

### Middleware Registration Order

```typescript
const app = new OpenAPIHono();

// 1. CloudFront origin verification (existing)
app.use("*", cfOriginVerify());

// 2. JWT authentication (existing, but authorization logic removed)
app.use("*", jwtAuth());

// 3. Authorization guard (NEW — registered globally, checks flag after handler)
app.use("/accounts/:accountId/*", authorizationGuard());

// 4. Per-route authorization (NEW — sets the flag)
app.get("/accounts/:accountId/arcs", authorize("account:read"), handler);
app.patch("/accounts/:accountId/arcs/:id", authorize("account:write"), handler);
```

### Guard Implementation Detail

The guard uses Hono's middleware pattern to check the flag:

```typescript
export function authorizationGuard(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    // After route handler runs, check if authorization was verified
    if (!c.get("authorizationVerified")) {
      // This means someone forgot to add authorize() to this route
      c.status(403);
      return c.json({ title: "Forbidden", errorCode: "AccessDenied" });
    }
  };
}
```

### Configuration

```typescript
// Per-route — explicit resource and permission
app.get("/accounts/:accountId/arcs",
  authorize("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs`),
  handler
);
app.patch("/accounts/:accountId/arcs/:id",
  authorize("arcs:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}`),
  handler
);
app.delete("/accounts/:accountId/arcs/:id",
  authorize("arcs:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}`),
  handler
);
```
