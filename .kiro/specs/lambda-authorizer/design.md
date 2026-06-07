# Technical Design

## Overview

Add an HTTP API authorizer code path to the single Lambda handler. The handler already routes WebSocket authorizer events (format 1.0 with `methodArn`) — this adds detection and handling of HTTP API authorizer events (format 2.0 with `routeArn`). Terraform is updated to enable simple responses so the handler returns `{ isAuthorized, context }` instead of IAM policy documents. The authorizer only verifies the JWT and passes `userId` — it does not extract `accountId` because the identity source is the `Authorization` header alone, and the cached response must be valid for all requests with the same token regardless of path.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Lambda Handler                            │
│                                                                 │
│  event ──► isStepFunctionTaskEvent? ──► onboardingHandler       │
│         ──► isEventBridgeEvent?     ──► domainHealthJob         │
│         ──► isSqsEvent?            ──► SQS routing              │
│         ──► isWsAuthorizerEvent?   ──► handleWsAuthorizer       │
│         ──► isHttpAuthorizerEvent? ──► handleHttpAuthorizer  ◄──NEW
│         ──► isWebSocketEvent?      ──► handleWebSocket          │
│         ──► (fallback)             ──► honoToApiGateway         │
└─────────────────────────────────────────────────────────────────┘
```

The HTTP API authorizer sits between the WS authorizer check and the WebSocket connection check. This preserves the existing WS authorizer priority (format 1.0 events with `methodArn` are caught first) while ensuring format 2.0 authorizer events never reach the Hono app.

## Event Discrimination

### HTTP API Authorizer Event (format 2.0)

```typescript
type HttpAuthorizerEvent = {
  version: "2.0";
  type: "REQUEST";
  routeArn: string;
  routeKey: string;
  rawPath: string;
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    http: { method: string; path: string };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  identitySource?: string[];
};
```

### Detection predicate

```typescript
function isHttpAuthorizerEvent(event: unknown): event is HttpAuthorizerEvent {
  const e = event as Record<string, unknown>;
  return e["version"] === "2.0" && e["type"] === "REQUEST" && typeof e["routeArn"] === "string";
}
```

This is distinct from `isWsAuthorizerEvent` which checks for `type === "REQUEST"` AND `typeof methodArn === "string"`. The two are mutually exclusive in practice (HTTP API format 2.0 events have `routeArn`, WebSocket format 1.0 events have `methodArn`), but the WS check runs first as a safety measure.

## Response Format

### Simple response (HTTP API authorizer with `enable_simple_responses = true`)

```typescript
type HttpAuthorizerResponse = {
  isAuthorized: boolean;
  context: Record<string, string>;
};
```

**Authorized:**
```json
{ "isAuthorized": true, "context": { "userId": "usr_abc123" } }
```

**Denied:**
```json
{ "isAuthorized": false, "context": {} }
```

## Why no accountId in the authorizer context

The HTTP API authorizer identity source is `$request.header.Authorization`. API Gateway caches the authorizer response keyed on this value. If the authorizer extracted `accountId` from the request path and included it in the context, the cached response for token X would always return the `accountId` from the first request — even when subsequent requests with the same token target a different account. The authorizer must only use data from the identity source (the token itself). The Hono JWT middleware handles `accountId` extraction from the URL path on every request, which is correct because it runs per-request without caching.

## Handler Implementation

```typescript
async function handleHttpAuthorizer(event: HttpAuthorizerEvent): Promise<HttpAuthorizerResponse> {
  const authHeader = event.headers?.["authorization"] ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match || !match[1]?.trim()) {
    return { isAuthorized: false, context: {} };
  }

  const token = match[1].trim();
  const verifyResult = await authService.verify(token);
  if (verifyResult.isErr()) {
    return { isAuthorized: false, context: {} };
  }

  const { userId } = verifyResult.value;
  return { isAuthorized: true, context: { userId } };
}
```

## Terraform Change

```hcl
resource "aws_apigatewayv2_authorizer" "main" {
  api_id                            = aws_apigatewayv2_api.main.id
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = aws_lambda_alias.production.invoke_arn
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true          # ◄── NEW
  identity_sources                  = ["$request.header.Authorization"]
  name                              = "${var.service_name}-authorizer"
  authorizer_result_ttl_in_seconds  = 3600
}
```

No changes to the WebSocket authorizer resource.

## Caching Behaviour

| API | Cache Key | TTL | Implication |
|-----|-----------|-----|-------------|
| HTTP API | Full `Authorization` header value | 3600s (1 hour) | Same token → same cached result. Different tokens → different cache entries. Token revocation takes up to 1 hour to take effect. |
| WebSocket | `?token=` query string value | Connection lifetime | Cached for the duration of the WebSocket connection. Acceptable because the connection IS the session. |

**TTL safety:** Authress JWTs are short-lived (typically 1 hour expiry). A revoked token that's still cached will be rejected by the Hono JWT middleware (defense-in-depth) on the next request after the cache entry expires. The 1-hour TTL matches the token lifetime, so in the worst case a revoked token is usable for at most its remaining validity period — which is the same as any JWT-based system without a revocation list.

## Files Changed

| File | Change |
|------|--------|
| `src/handler.ts` | Add `HttpAuthorizerEvent` type, `HttpAuthorizerResponse` type, `isHttpAuthorizerEvent` predicate, `handleHttpAuthorizer` function, and wire into the event routing chain |
| `deploy/api.tf` | Add `enable_simple_responses = true` to `aws_apigatewayv2_authorizer.main` |

## Files NOT Changed

| File | Reason |
|------|--------|
| `src/api/app.ts` | Hono JWT middleware stays as-is (defense-in-depth, handles accountId extraction) |
| `src/api/authress-auth.ts` | AuthService interface unchanged |
| `src/api/authorization-middleware.ts` | Per-route RBAC unchanged |
| `src/api/authorization-guard.ts` | Safety net unchanged |

## Testing Strategy

Unit tests for the HTTP authorizer handler:
1. Valid Bearer token → `{ isAuthorized: true, context: { userId } }`
2. Missing Authorization header → `{ isAuthorized: false, context: {} }`
3. Malformed Authorization header (no "Bearer" prefix) → `{ isAuthorized: false, context: {} }`
4. Invalid/expired token (AuthService returns error) → `{ isAuthorized: false, context: {} }`
5. Event discrimination: HTTP authorizer event routes to `handleHttpAuthorizer`, not Hono
6. Event discrimination: WS authorizer event still routes to `handleWsAuthorizer`
7. Event discrimination: Regular HTTP request (no `type: "REQUEST"`) routes to Hono
