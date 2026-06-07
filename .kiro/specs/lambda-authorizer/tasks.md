# Implementation Tasks

## Task 1: Add HTTP authorizer handler to handler.ts (R1, R2, R3, R7)

- [x] Add `HttpAuthorizerEvent` type with fields: `version: "2.0"`, `type: "REQUEST"`, `routeArn: string`, `routeKey: string`, `rawPath: string`, `headers: Record<string, string>`, `queryStringParameters?: Record<string, string>`, `requestContext`, `identitySource?: string[]`
- [x] Add `HttpAuthorizerResponse` type: `{ isAuthorized: boolean; context: Record<string, string> }`
- [x] Add `isHttpAuthorizerEvent(event: unknown): event is HttpAuthorizerEvent` predicate — checks `version === "2.0"` AND `type === "REQUEST"` AND `typeof routeArn === "string"`
- [x] Add `handleHttpAuthorizer(event: HttpAuthorizerEvent): Promise<HttpAuthorizerResponse>` function:
  - Read `event.headers?.["authorization"]`
  - Match with `/^Bearer\s+(.+)$/i`, trim the captured token
  - If no match or empty token: return `{ isAuthorized: false, context: {} }`
  - Call `authService.verify(token)`
  - If error: return `{ isAuthorized: false, context: {} }`
  - Return `{ isAuthorized: true, context: { userId } }`
- [x] Wire `isHttpAuthorizerEvent` check into the handler routing chain AFTER `isWsAuthorizerEvent` and BEFORE `isWebSocketEvent`:
  ```
  if (isWsAuthorizerEvent(event)) { ... }
  if (isHttpAuthorizerEvent(event)) { return handleHttpAuthorizer(event as HttpAuthorizerEvent); }
  if (isWebSocketEvent(event)) { ... }
  ```
- [x] Verify `npm run build` passes
- [x] Commit: `git add src/handler.ts` then commit

**Validates:** Requirements 1, 2, 3, 7

## Task 2: Write tests for HTTP authorizer handler (R2, R3, R7)

- [x] Create `tests/http-authorizer.test.ts`
- [x] Test: valid Bearer token → returns `{ isAuthorized: true, context: { userId: "test-user" } }`
- [x] Test: missing authorization header → returns `{ isAuthorized: false, context: {} }`
- [x] Test: authorization header without "Bearer" prefix → returns `{ isAuthorized: false, context: {} }`
- [x] Test: authorization header with "Bearer" but only whitespace after → returns `{ isAuthorized: false, context: {} }`
- [x] Test: AuthService returns error → returns `{ isAuthorized: false, context: {} }`
- [x] Test: `isHttpAuthorizerEvent` returns true for event with `version: "2.0"`, `type: "REQUEST"`, `routeArn: "arn:..."` 
- [x] Test: `isHttpAuthorizerEvent` returns false for event without `routeArn`
- [x] Test: `isHttpAuthorizerEvent` returns false for event without `type: "REQUEST"` (regular HTTP request)
- [x] Test: `isWsAuthorizerEvent` still returns true for event with `type: "REQUEST"` and `methodArn` (no regression)
- [x] Verify `npm run test` passes
- [x] Commit: `git add tests/http-authorizer.test.ts` then commit

**Validates:** Requirements 2, 3, 7

## Task 3: Enable simple responses in Terraform (R4)

- [x] Add `enable_simple_responses = true` to `aws_apigatewayv2_authorizer.main` in `deploy/api.tf`
- [x] Verify `aws_apigatewayv2_authorizer.ws` is NOT modified
- [x] Verify `authorizer_payload_format_version = "2.0"` is still present on `aws_apigatewayv2_authorizer.main`
- [x] Verify `authorizer_result_ttl_in_seconds = 3600` is still present on `aws_apigatewayv2_authorizer.main`
- [x] Commit: `git add deploy/api.tf` then commit

**Validates:** Requirement 4

## Task 4: Remove TODO item (cleanup)

- [x] Remove the "Review and implement Lambda authorizer for both API Gateway APIs" item from `TODO.md`
- [x] Commit: `git add TODO.md` then commit

**Validates:** Completion cleanup
