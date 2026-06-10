# Tasks: Domain/Alias/Sender DynamoDB Schema Refactor

## Phase 1: Type breaking changes

- [ ] 1. Add `AliasKey` and `SenderKey` types to `src/types/index.ts`. Update `Alias` interface to have `domain: string` and `alias: string` fields (keep `address` as computed getter or remove entirely — TBD during implementation).
- [ ] 2. Rewrite alias methods in `account-database.ts` to use new SK format (`DOMAIN#{domain}#ALIAS#{alias}`) and accept `AliasKey` instead of raw `address: string`. Write GSI keys on alias items.
- [ ] 3. Rewrite sender methods in `account-database.ts` to use new SK format (`DOMAIN#{domain}#ALIAS#{alias}#SENDER#{senderDomain}`) and accept `SenderKey`. Write GSI keys on sender items.
- [ ] 4. Rewrite domain methods in `account-database.ts` — `createDomain` adds ConditionExpression + GSI keys, `listDomains` filters to only bare domain items.
- [ ] 5. Delete `listAliasesForDomain` (dead code).
- [ ] 6. Add `resolveAccountForDomain(domain: string)` method — queries GSI, sorts by createdAt, returns first accountId.

## Phase 2: Migrate callers (compiler-driven)

- [ ] 7. Run `tsc --noEmit`, enumerate all broken call sites.
- [ ] 8. Migrate `src/api/app.ts` callers — alias CRUD routes, sender routes, domain routes (including POST with ownership check).
- [ ] 9. Migrate `src/processor/processor.ts` callers — `getSender`, `getAlias` via `getProcessorAccountContext`.
- [ ] 10. Migrate `src/handler.ts` — remove `notification.accountId`, add `resolveAccountForDomain` call to resolve accountId from recipient domain.
- [ ] 11. Migrate `src/onboarding/onboarding-task-handler.ts` — `listDomains` caller.
- [ ] 12. Migrate `src/jobs/domain-health-job.ts` — `scanAllDomains` filter update.
- [ ] 13. Migrate `renameAlias` — new SK structure for rename logic.

## Phase 3: Test migration

- [ ] 14. Update all test mocks to match new method signatures (API tests, processor tests, handler tests).
- [ ] 15. Run `npm run test` — zero type errors, all tests pass.

## Phase 4: Cleanup

- [ ] 16. Remove any remaining references to old SK patterns (`ALIAS#`, `SENDER#` standalone prefixes).
- [ ] 17. Verify `npm run test` passes clean. Commit.
