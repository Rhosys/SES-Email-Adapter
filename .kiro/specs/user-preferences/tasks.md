# User Configuration — Tasks

## Backend

- [x] Add `IUserConfiguration` type and `USER_CONFIGURATION_DEFAULTS` to `src/types/index.ts`
- [x] Add `getUserConfiguration` and `updateUserConfiguration` to database layer (using `ACCOUNTS_TABLE`, key `USER#{userId}` / `CONFIG`)
- [x] Add zod schemas for configuration request/response in `src/api/schemas.ts` and `src/api/requests.ts`
- [x] Create `src/api/userApi.ts` with GET and PATCH `/user/:userId/configuration` routes (inline userId-match guard, set `authorizationVerified`)
- [x] Register `UserApi` in `src/api/app.ts`
- [x] Add tests for user configuration API routes
- [x] Remove `undoWindowSeconds` from send response — only return `undoExpiresAt`
- [x] Document undo-send mechanism in arcsApi, threadsApi, and undo-window.ts

## Site (separate repo, separate commits)

- [x] Add `getUserConfiguration(userId)` and `updateUserConfiguration(userId, body)` to `src/lib/api.ts`
- [x] Create `src/stores/userConfig.ts` exposing reactive `postSendView`
- [x] Fetch user configuration on app mount (after auth resolves userId)
- [x] Update "After send" setting UI to toggle `return_to_inbox` / `stay_on_thread` via user config store
- [x] Remove `afterSendAction` from Account type, account store, `api.updateAccount` params
- [x] Update `DraftSignalCard` to use `postSendView` for navigation (not arc state)
- [x] Remove `afterSendAction` from mock data
