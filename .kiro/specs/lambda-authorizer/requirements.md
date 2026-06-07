# Requirements Document

## Introduction

Add an HTTP API Gateway Lambda authorizer handler to the email-catcher backend. The single Lambda function already handles WebSocket authorizer events (payload format 1.0 with `methodArn`), but HTTP API Gateway sends payload format 2.0 events (with `version: "2.0"` and `routeArn`) which currently fall through to the Hono app path — producing responses API Gateway cannot interpret as authorizer results. This feature adds a dedicated code path for HTTP API authorizer events, enables simple responses in Terraform, and ensures the authorizer verifies the JWT and passes `userId` through to the integration. The existing Hono JWT middleware remains as defense-in-depth and continues to handle `accountId` extraction from the URL path.

## Glossary

- **Handler**: The single Lambda entry point (`src/handler.ts`) that routes events to the appropriate processing path based on event shape
- **HTTP_Authorizer_Event**: An API Gateway HTTP API authorizer event with payload format version 2.0, identified by `version: "2.0"` and `type: "REQUEST"` and the presence of `routeArn`
- **WS_Authorizer_Event**: An API Gateway WebSocket authorizer event with payload format version 1.0, identified by `type: "REQUEST"` and the presence of `methodArn`
- **Simple_Response**: The HTTP API authorizer response format `{ isAuthorized: boolean, context: Record<string, string> }` enabled by `enable_simple_responses = true` in Terraform
- **IAM_Policy_Response**: The WebSocket authorizer response format containing a full IAM policy document with Allow/Deny statements
- **AuthService**: The `AuthressAuthService` class that verifies JWTs against `https://login.rhosys.cloud` and returns `{ userId }` on success
- **Identity_Source**: The request element API Gateway uses as the cache key — `$request.header.Authorization` for HTTP API, `route.request.querystring.token` for WebSocket
- **TTL**: Time-to-live for cached authorizer results (currently 3600 seconds / 1 hour for the HTTP API authorizer)
- **Defense_In_Depth**: The pattern where the Hono app re-verifies the JWT independently of the authorizer, providing a second authentication layer

## Requirements

### Requirement 1: Detect HTTP API authorizer events

**User Story:** As a developer, I want the Lambda handler to correctly identify HTTP API authorizer events and route them to a dedicated handler, so that they do not fall through to the Hono app path.

#### Acceptance Criteria

1. WHEN an event has `version: "2.0"` AND `type: "REQUEST"` AND a `routeArn` property, THE Handler SHALL classify it as an HTTP_Authorizer_Event
2. WHEN an event has `type: "REQUEST"` AND a `methodArn` property AND does NOT have `version: "2.0"`, THE Handler SHALL classify it as a WS_Authorizer_Event (existing behaviour preserved)
3. THE Handler SHALL evaluate event checks in this order: WS_Authorizer_Event → HTTP_Authorizer_Event → WebSocket connection → `honoToApiGateway` fallback, so that the existing WebSocket authorizer path is not disrupted and authorizer events are never passed to Hono
4. IF an event has `version: "2.0"` AND `type: "REQUEST"` AND a `routeArn` property AND also has a `methodArn` property, THEN THE Handler SHALL classify it as a WS_Authorizer_Event because the WS check is evaluated first in the priority order
5. IF an event has `version: "2.0"` but does NOT have `type: "REQUEST"`, THEN THE Handler SHALL NOT classify it as an HTTP_Authorizer_Event

### Requirement 2: Verify JWT from Authorization header

**User Story:** As the system, I want the HTTP authorizer to extract and verify the Bearer token from the Authorization header, so that only authenticated requests are authorized.

#### Acceptance Criteria

1. WHEN an HTTP_Authorizer_Event is received, THE Handler SHALL read the `authorization` header (lowercase — API Gateway HTTP API v2.0 normalises header keys to lowercase) and strip the `Bearer ` prefix using a case-insensitive match on the word "Bearer" followed by one or more whitespace characters
2. IF the `authorization` header is missing, does not start with `Bearer ` (case-insensitive), or contains only whitespace after the prefix, THEN THE Handler SHALL return `{ isAuthorized: false }`
3. WHEN a non-empty token is extracted, THE Handler SHALL verify it using the existing AuthService (`authService.verify(token)`)
4. IF the AuthService returns an error result, THEN THE Handler SHALL return `{ isAuthorized: false }`
5. THE Handler SHALL NOT use any request data beyond the `authorization` header — the identity source is `$request.header.Authorization` and the authorizer response is cached against that single value; using path, query string, or other headers would produce incorrect cached results for different requests sharing the same token

### Requirement 3: Return simple authorizer response

**User Story:** As the system, I want the HTTP authorizer to return the simple response format, so that API Gateway can interpret the result without IAM policy parsing.

#### Acceptance Criteria

1. WHEN the JWT is valid, THE Handler SHALL return `{ isAuthorized: true, context: { userId } }` directly (not wrapped in a Lambda proxy response with `statusCode`/`body`)
2. IF the JWT is invalid or missing, THEN THE Handler SHALL return `{ isAuthorized: false, context: {} }`
3. THE Handler SHALL NOT return an IAM policy document for HTTP_Authorizer_Events (simple responses only)
4. ALL values in the `context` object SHALL be strings
5. THE Handler SHALL NOT include any keys in the response object other than `isAuthorized` and `context`
6. THE `context` SHALL contain only `userId` — no `accountId`, no path-derived values, no other request-specific data (the authorizer result is cached per-token, not per-request)

### Requirement 4: Enable simple responses in Terraform

**User Story:** As a developer, I want the Terraform configuration to enable simple responses for the HTTP API authorizer, so that API Gateway accepts the `{ isAuthorized }` format.

#### Acceptance Criteria

1. THE `aws_apigatewayv2_authorizer.main` resource SHALL include `enable_simple_responses = true`
2. THE `aws_apigatewayv2_authorizer.main` resource SHALL retain `authorizer_payload_format_version = "2.0"` (required for simple responses to function)
3. THE `aws_apigatewayv2_authorizer.ws` resource SHALL NOT include `enable_simple_responses` and SHALL retain its existing attributes unchanged (it uses IAM policy responses, not simple format)
4. THE `authorizer_result_ttl_in_seconds` for `aws_apigatewayv2_authorizer.main` SHALL remain at 3600

### Requirement 5: Preserve WebSocket authorizer behaviour

**User Story:** As a developer, I want the existing WebSocket authorizer to continue working unchanged, so that WebSocket connections are not disrupted by this change.

#### Acceptance Criteria

1. THE `isWsAuthorizerEvent` detection logic SHALL continue to match events where `type` equals `"REQUEST"` AND `methodArn` is a string
2. WHEN a valid token is provided AND `accountId` can be resolved, THE `handleWsAuthorizer` function SHALL return a policy document with Effect `"Allow"`, `principalId` set to the verified `userId`, and a `context` object containing `accountId` and `userId`
3. IF the token is missing, token verification fails, or `accountId` cannot be resolved, THEN THE `handleWsAuthorizer` function SHALL return a policy document with Effect `"Deny"`, `principalId` `"anonymous"`, and an empty `context`
4. THE WebSocket authorizer SHALL extract the token from `queryStringParameters.token` first, falling back to the `Authorization` header with the `Bearer` prefix stripped
5. THE WebSocket authorizer SHALL resolve `accountId` from the connection path matching `/api/accounts/{accountId}`, falling back to `queryStringParameters.accountId`

### Requirement 6: Maintain Hono JWT middleware as defense-in-depth

**User Story:** As a developer, I want the Hono app's internal JWT verification middleware to remain active, so that requests are authenticated even if the authorizer cache serves a stale result.

#### Acceptance Criteria

1. THE Hono JWT middleware in `src/api/app.ts` SHALL be registered as a global middleware on all routes (excluding OPTIONS preflight requests) and SHALL NOT be conditionally disabled or removed by configuration
2. WHEN a request carries a valid Bearer token, THE Hono JWT middleware SHALL verify the token signature and expiry via the AuthService, extract the `userId` from the verified claims, derive the `accountId` from the URL path, and set the `auth` context with `{ accountId, userId }`
3. IF the Bearer token is missing, malformed, or fails AuthService verification, THEN THE Hono JWT middleware SHALL reject the request with HTTP 401 regardless of any upstream authorizer result
4. WHEN both the API Gateway authorizer and the Hono JWT middleware independently verify the same request successfully, THE request SHALL proceed to the route handler without requiring the two layers to share state or coordinate results

### Requirement 7: Event discrimination correctness

**User Story:** As a developer, I want the handler to never misroute events between the HTTP authorizer, WebSocket authorizer, WebSocket connection, and Hono app paths, so that each event type is handled by exactly one code path.

#### Acceptance Criteria

1. THE Handler SHALL process events in this priority order: Step Function tasks → EventBridge → SQS → WS_Authorizer_Event → HTTP_Authorizer_Event → WebSocket connection → Hono app
2. WHEN an event has `version: "2.0"` but does NOT have `type: "REQUEST"`, THE Handler SHALL route it to the Hono app path without evaluating the HTTP_Authorizer_Event or WS_Authorizer_Event detection predicates
3. THE HTTP_Authorizer_Event detection SHALL require BOTH `type: "REQUEST"` AND `routeArn` to be present, preventing false matches on regular HTTP requests that also have `version: "2.0"`
4. IF a future event type is added that has `version: "2.0"` and `type: "REQUEST"` but no `routeArn`, THE Handler SHALL NOT classify it as an HTTP_Authorizer_Event (the `routeArn` check provides specificity)
5. IF an event does not match any earlier detection predicate in the priority order, THE Handler SHALL route it to the Hono app path as the terminal fallback
