# User Configuration — Tasks

## Backend

- [ ] Add `IUserConfiguration` type and `USER_CONFIGURATION_DEFAULTS` to `src/types/index.ts`
- [ ] Add `getUserConfiguration` and `updateUserConfiguration` to database layer (using `ACCOUNTS_TABLE`, key `USER#{userId}` / `CONFIG`)
- [ ] Add zod schemas for configuration request/response in `src/api/schemas.ts` and `src/api/requests.ts`
- [ ] Create `src/api/userApi.ts` with GET and PATCH `/user/:userId/configuration` routes (inline userId-match guard, set `authorizationVerified`)
- [ ] Register `UserApi` in `src/api/app.ts`
- [ ] Add tests for user configuration database methods
- [ ] Add tests for user configuration API routes

## Site (separate repo, separate commits)

- [ ] Add `getUserConfiguration(userId)` and `updateUserConfiguration(userId, body)` to `src/lib/api.ts`
- [ ] Create a `src/stores/userConfig.ts` (or composable) that fetches config on login and exposes reactive `afterSendAction`
- [ ] Fetch user configuration on app mount (after auth resolves userId) and hydrate the store
- [ ] Move the "After send" setting UI from SettingsView Email tab to the Profile tab (it's user-level, not account-level)
- [ ] Update the "After send" toggle buttons to call `updateUserConfiguration` instead of `api.updateAccount`
- [ ] Remove `afterSendAction` from the account type (`src/types/server.ts`), account store, and `api.updateAccount` params
- [ ] Update `DraftSignalCard` to read `afterSendAction` from the user config store instead of `accountStore.account?.afterSendAction`
- [ ] In `DraftSignalCard.sendAndArchive` / `sendAndWait`: after successful send, if `afterSendAction === "archive"`, call `api.patchArc(accountId, arcId, { status: "archived" })` — this already exists in `sendAndArchive`, just wire it to the preference
- [ ] Remove the hardcoded "Send + Archive" / "Send + Wait" button split — use one "Send" button whose post-send behavior is driven by the preference
- [ ] Remove `afterSendAction` from mock data (`src/mocks/data/accounts.ts`, `src/mocks/data/audit.ts`)
