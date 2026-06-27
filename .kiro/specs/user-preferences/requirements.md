# User Configuration

## Problem

Per-user settings like "after send action" have no storage. The old `afterSendAction` on Account has been removed. Users need a way to store personal configuration that is global to the user (not per-account).

## Requirements

1. Introduce a user configuration item in DynamoDB keyed by `userId` alone.
2. Expose `GET /user/:userId/configuration` — returns the user's configuration.
3. Expose `PATCH /user/:userId/configuration` — updates the user's configuration.
4. Auth: validate that `:userId` in the path matches the JWT-extracted `userId`. No Authress permission check needed — users can only access their own config.
5. First field: `afterSendAction: "archive" | "keep_active"` (system default: `keep_active`).
6. The site reads the user's config and drives after-send behavior client-side (calls existing `PATCH /arcs/:arcId` to archive). No backend worker changes needed.
7. If no config item exists, return system defaults transparently.
8. Schema must be extensible — future fields (shortcuts, theme, notification prefs) appear without migration.

## Constraints

- User config is global — not scoped to any account.
- Account-specific overrides can be nested under a keyed sub-object in future if ever needed, but not now.
- No Authress `checkAccess` call — simple path-param-matches-JWT validation.
- The configuration item lives in the existing accounts table (new `USER#` partition key pattern).
