# User Configuration — Design

## Storage

Single DynamoDB item per user in the existing accounts table.

**Key structure:**
- `pk`: `USER#{userId}`
- `sk`: `CONFIG`

No GSI needed — accessed only by primary key.

**Item shape:**
```typescript
interface UserConfigItem {
  pk: string           // USER#{userId}
  sk: string           // CONFIG
  userId: string
  afterSendAction: "archive" | "keep_active"
  createdAt: string
  updatedAt: string
}
```

New fields appear on the item as they're added — DynamoDB document model, no migration.

## Type

```typescript
// src/types/index.ts
export interface IUserConfiguration {
  afterSendAction: "archive" | "keep_active"
}

export const USER_CONFIGURATION_DEFAULTS: IUserConfiguration = {
  afterSendAction: "keep_active",
}
```

## API

### GET /user/:userId/configuration

1. Extract `userId` from JWT (`c.var.auth.userId`).
2. Validate path `:userId` === JWT userId. If mismatch → 403.
3. GetItem from DynamoDB.
4. If item missing → return `USER_CONFIGURATION_DEFAULTS`.
5. Return `IUserConfiguration` shape (strip DDB keys).

Response:
```json
{ "afterSendAction": "keep_active" }
```

### PATCH /user/:userId/configuration

1. Same userId validation as GET.
2. Validate body against zod schema (partial `IUserConfiguration`).
3. Upsert: UpdateCommand with `SET` expressions, creating item if absent.
4. Return updated full configuration.

Request body (all fields optional):
```json
{ "afterSendAction": "archive" }
```

## Auth pattern

No `authz()` middleware call. Instead, a lightweight inline guard:

```typescript
const jwtUserId = c.var.auth.userId
const pathUserId = c.req.param("userId")
if (jwtUserId !== pathUserId) return err(c, 403, "Forbidden")
```

This bypasses the authorization guard's "must call authz()" safety net. The route must explicitly set `c.set("authorizationVerified", true)` after the userId check to satisfy the guard.

## Database method

New class `UserConfigDatabase` (or methods on `AccountDatabase` — same table, same client):

- `getUserConfiguration(userId: string): Promise<Result<IUserConfiguration, DbError>>`
- `updateUserConfiguration(userId: string, update: Partial<IUserConfiguration>): Promise<Result<IUserConfiguration, DbError>>`

Both use `ACCOUNTS_TABLE`.

## Client-side consumption

The backend does NOT read user configuration to drive behavior. The site reads the user's `afterSendAction` preference and, if set to `"archive"`, calls `PATCH /accounts/:accountId/arcs/:arcId` with `{ status: "archived" }` after a successful send. No backend logic change — the existing arc patch endpoint handles it.

## Route registration

New `UserApi` class registered in `app.ts` after the auth middleware, with explicit `authorizationVerified` flag set (no Authress call).

#[[src/api/app.ts]]
